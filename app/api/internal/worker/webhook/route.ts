import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { GitHubAppService } from "@/lib/services/githubAppService";
import { GitHubService } from "@/lib/services/githubService";
import {
  formatPRReviewMarkdown,
  reviewPullRequest,
} from "@/lib/services/prReviewService";
import { isAxiosError } from "axios";
import { sanitizeError } from "@/lib/middleware";
import crypto from "crypto";
import { QuotaService, QuotaExceededError } from "@/lib/services/quotaService";

export const runtime = "nodejs";
export const maxDuration = 300; // 5 minutes max duration for Vercel

// Secure this internal route
function isInternalAuthorized(request: NextRequest): boolean {
  // Can use a specific secret or just reuse the webhook secret
  const authHeader = request.headers.get("authorization");
  const secret = process.env.GITHUB_WEBHOOK_SECRET || process.env.JWT_SECRET || "";
  
  if (!secret) return false;
  
  const expectedToken = `Bearer ${crypto.createHash('sha256').update(secret).digest('hex')}`;
  
  try {
    const a = Buffer.from(expectedToken);
    const b = Buffer.from(authHeader || "");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  if (!isInternalAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { eventId } = await request.json().catch(() => ({}));

  if (!eventId) {
    return NextResponse.json({ error: "eventId is required" }, { status: 400 });
  }

  const webhookEvent = await prisma.webhookEvent.findUnique({
    where: { id: eventId },
  });

  if (!webhookEvent) {
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
  }

  if (webhookEvent.status !== "pending") {
    return NextResponse.json(
      { ok: true, ignored: true, reason: "already_processed" },
      { status: 200 }
    );
  }

  // Mark as processing
  await prisma.webhookEvent.update({
    where: { id: eventId },
    data: { status: "processing" },
  });

  try {
    const payload = webhookEvent.payload as any;
    const owner = payload.repository?.owner?.login;
    const repo = payload.repository?.name;
    const number = payload.pull_request?.number;
    const installationId = payload.installation?.id;

    if (!owner || !repo || !number || !installationId) {
      throw new Error("Missing required fields in payload");
    }

    const repoFullName = `${owner}/${repo}`;

    const enabledRepo = await prisma.gitHubRepo.findFirst({
      where: {
        repoFullName,
        enabled: true,
        OR: [
          { installationId: BigInt(installationId) },
          { installationId: null },
        ],
      },
      orderBy: [{ updatedAt: "desc" }],
    });

    if (!enabledRepo) {
      await prisma.webhookEvent.update({
        where: { id: eventId },
        data: { status: "completed", error: "Repo not enabled" },
      });
      return NextResponse.json({ ok: true, ignored: true, reason: "repo_not_enabled" });
    }

    // Backfill installationId for future lookups.
    await prisma.gitHubRepo.updateMany({
      where: {
        repoFullName,
        enabled: true,
        installationId: null,
      },
      data: { installationId: BigInt(installationId) },
    });

    const app = new GitHubAppService();
    const installationToken = await app.getInstallationAccessToken(installationId);

    const github = new GitHubService(installationToken);
    const pr = await github.getPullRequest(owner, repo, number);
    const headSha = pr?.head?.sha;
    if (!headSha) {
      throw new Error("Missing head SHA from GitHub PR response");
    }

    // Upsert PR record.
    const prRecord = await prisma.pullRequest.upsert({
      where: {
        repoId_prNumber: {
          repoId: enabledRepo.id,
          prNumber: number,
        },
      },
      create: {
        repoId: enabledRepo.id,
        prNumber: number,
        title: pr.title,
        author: pr.user?.login || "unknown",
        headSha,
        htmlUrl: pr.html_url,
        status: "OPEN",
      },
      update: {
        title: pr.title,
        author: pr.user?.login || "unknown",
        headSha,
        htmlUrl: pr.html_url,
        status: "OPEN",
      },
    });

    // Dedupe/lock
    let reviewRow: any = null;
    try {
      reviewRow = await prisma.pRReview.create({
        data: {
          pullRequestId: prRecord.id,
          headSha,
          reviewText: "(processing)",
          rawJson: {},
        },
        select: { id: true, pullRequestId: true, headSha: true },
      });
    } catch (e: any) {
      if (e?.code === "P2002") {
        await prisma.webhookEvent.update({
          where: { id: eventId },
          data: { status: "completed", error: "Already reviewed (deduped)" },
        });
        return NextResponse.json({ ok: true, ignored: true, reason: "already_reviewed" });
      }
      throw e;
    }

    try {
      // Gate Gemini analysis with Installation Quota
      try {
        await QuotaService.checkAndReserveQuota(installationId, 10000);
      } catch (quotaError: any) {
        if (quotaError instanceof QuotaExceededError) {
          console.warn(`[Quota] Installation ${installationId} exhausted quota: ${quotaError.message}`);
          
          const rateLimitMessage = `> [!WARNING]\n> **GitVerse AI Analysis Quota Exhausted**\n>\n> ${quotaError.message}\n> Analysis will resume automatically once the quota window resets.\n\n_Note: This is an automated message to prevent excessive API usage (Denial-of-Wallet protection)._`;
          
          // Check if we already posted a rate limit message recently to avoid spam
          const recentReviews = await prisma.pRReview.findFirst({
            where: {
              pullRequest: { repoId: enabledRepo.id, prNumber: number },
              reviewText: { contains: "Quota Exhausted" },
              createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) } // within last hour
            }
          });
          
          if (!recentReviews) {
            await github.postPullRequestComment(owner, repo, number, rateLimitMessage);
            
            // Log it in PRReview so we don't spam it again
            await prisma.pRReview.update({
              where: { id: reviewRow.id },
              data: {
                reviewText: rateLimitMessage,
                rawJson: { quota_exceeded: true },
              }
            });
          } else {
             // Cleanup placeholder if not needed
             await prisma.pRReview.delete({ where: { id: reviewRow.id } }).catch(() => null);
          }
          
          await prisma.webhookEvent.update({
            where: { id: eventId },
            data: { status: "rate_limited", error: quotaError.message },
          });

          return NextResponse.json(
            { error: "Quota exceeded", message: quotaError.message },
            { status: 429 }
          );
        }
        throw quotaError; // Re-throw other errors
      }

      const { review, prUrl } = await reviewPullRequest({
        owner,
        repo,
        number,
        githubToken: installationToken,
      });

      const comment = formatPRReviewMarkdown({ review, prUrl });
      let postedUrl: string | null = null;
      let postError: any = null;

      try {
        const posted = await github.postPullRequestComment(owner, repo, number, comment);
        postedUrl = posted?.html_url || null;
      } catch (err: unknown) {
        if (isAxiosError(err)) {
          const status = err.response?.status;
          const data = err.response?.data as any;
          if (status === 403) {
            postError = {
              status,
              message: String(data?.message || err.message || "Forbidden"),
              documentation_url: data?.documentation_url,
              url: err.config?.url,
            };
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }

      await prisma.pRReview.update({
        where: { id: reviewRow.id },
        data: {
          reviewText: comment,
          rawJson: {
            ...(review as any),
            _githubPost: { ok: Boolean(postedUrl), postedUrl, error: postError },
          } as any,
        },
      });

      await prisma.webhookEvent.update({
        where: { id: eventId },
        data: { status: "completed" },
      });

      return NextResponse.json({ ok: true, posted: postedUrl, postError });
    } catch (innerError: any) {
      if (reviewRow) {
        await prisma.pRReview.delete({ where: { id: reviewRow.id } }).catch(() => null);
      }
      throw innerError;
    }
  } catch (error: any) {
    const errorDetails = sanitizeError(error);
    console.error("Worker processing error:", errorDetails);
    
    await prisma.webhookEvent.update({
      where: { id: eventId },
      data: { status: "failed", error: String(error?.message || error) },
    });

    return NextResponse.json(
      { error: "Failed to process event", details: errorDetails },
      { status: 500 }
    );
  }
}
