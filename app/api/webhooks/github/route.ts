import { sanitizeError } from "@/lib/middleware";
import { NextRequest, NextResponse } from "next/server";
import { verifyGitHubWebhookSignature } from "@/lib/utils/githubWebhook";
import { GitHubAppService } from "@/lib/services/githubAppService";
import { GitHubService } from "@/lib/services/githubService";
import prisma from "@/lib/prisma";
import {
  formatPRReviewMarkdown,
  reviewPullRequest,
} from "@/lib/services/prReviewService";
import { isAxiosError } from "axios";
import { QuotaService, QuotaExceededError } from "@/lib/services/quotaService";
import crypto from "crypto";

type PullRequestWebhookPayload = {
  action?: string;
  installation?: { id?: number };
  repository?: {
    name?: string;
    owner?: { login?: string };
  };
  pull_request?: {
    number?: number;
    html_url?: string;
    draft?: boolean;
  };
  sender?: {
    type?: string;
    login?: string;
  };
};

function shouldHandlePullRequestAction(action: string | undefined): boolean {
  return (
    action === "opened" ||
    action === "reopened" ||
    action === "synchronize" ||
    action === "ready_for_review"
  );
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  const signature = request.headers.get("x-hub-signature-256");
  const event = request.headers.get("x-github-event");
  const deliveryId = request.headers.get("x-github-delivery") || crypto.randomUUID();
  const secret = process.env.GITHUB_WEBHOOK_SECRET || "";

  // 1. Verify Signature
  if (
    !verifyGitHubWebhookSignature({
      rawBody,
      signature256Header: signature,
      webhookSecret: secret,
    })
  ) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // 2. Global Rate Limiting (Phase 2)
  const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0] || "global";
  const isAllowed = await QuotaService.checkGlobalRateLimit(clientIp);
  if (!isAllowed) {
    return NextResponse.json({ error: "Global rate limit exceeded" }, { status: 429 });
  }

  // 3. Parse JSON
  let payload: PullRequestWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const action = payload.action;
  const owner = payload.repository?.owner?.login;
  const repo = payload.repository?.name;
  const repoFullName = owner && repo ? `${owner}/${repo}` : null;
  const installationId = payload.installation?.id;

  // 4. Create WebhookEvent for observability and replay prevention (Phase 5)
  let webhookEvent;
  try {
    webhookEvent = await prisma.webhookEvent.create({
      data: {
        githubDeliveryId: deliveryId,
        event: event || "unknown",
        action: action,
        installationId: installationId ? BigInt(installationId) : null,
        repositoryFullName: repoFullName,
        payload: payload as any,
        status: "PROCESSING",
      },
    });
  } catch (e: any) {
    if (e?.code === "P2002") {
      console.warn(`[Webhook] Duplicate delivery ID rejected: ${deliveryId}`);
      return NextResponse.json({ error: "Duplicate delivery" }, { status: 409 });
    }
    return NextResponse.json({ error: "Failed to record event" }, { status: 500 });
  }

  // Helper to safely update webhook status
  const completeWebhook = async (status: "COMPLETED" | "FAILED" | "RATE_LIMITED", errorMsg?: string, response?: any) => {
    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: { status, errorMessage: errorMsg ? errorMsg.substring(0, 500) : null },
    });
    return response;
  };

  if (event !== "pull_request") {
    return completeWebhook("COMPLETED", undefined, NextResponse.json(
      { ok: true, ignored: true, event },
      { status: 200 }
    ));
  }

  if (!shouldHandlePullRequestAction(action)) {
    return completeWebhook("COMPLETED", undefined, NextResponse.json(
      { ok: true, ignored: true, action },
      { status: 200 }
    ));
  }

  // Ignore draft PRs until they become ready_for_review
  if (payload.pull_request?.draft && action !== "ready_for_review") {
    return completeWebhook("COMPLETED", undefined, NextResponse.json(
      { ok: true, ignored: true, reason: "draft" },
      { status: 200 }
    ));
  }

  // Avoid replying to bots (including ourselves)
  if (payload.sender?.type === "Bot") {
    return completeWebhook("COMPLETED", undefined, NextResponse.json(
      { ok: true, ignored: true, reason: "bot" },
      { status: 200 }
    ));
  }

  const number = payload.pull_request?.number;

  if (!owner || !repo || !number || !installationId) {
    return completeWebhook("FAILED", "Missing required fields", NextResponse.json(
      {
        error: "Missing required fields",
        details: { owner, repo, number, installationId },
      },
      { status: 400 }
    ));
  }

  try {
    // Gate by DB selection: only auto-review repos that users explicitly enabled.
    const enabledRepo = await prisma.gitHubRepo.findFirst({
      where: {
        repoFullName: repoFullName!,
        enabled: true,
        OR: [
          { installationId: BigInt(installationId) },
          { installationId: null },
        ],
      },
      orderBy: [{ updatedAt: "desc" }],
    });

    if (!enabledRepo) {
      return completeWebhook("COMPLETED", undefined, NextResponse.json(
        { ok: true, ignored: true, reason: "repo_not_enabled", repoFullName },
        { status: 200 }
      ));
    }

    // Backfill installationId for future lookups.
    await prisma.gitHubRepo.updateMany({
      where: {
        repoFullName: repoFullName!,
        enabled: true,
        installationId: null,
      },
      data: { installationId: BigInt(installationId) },
    });

    const app = new GitHubAppService();
    const installationToken = await app.getInstallationAccessToken(installationId);

    // 5. Enforce Installation Quota (Phase 3 & 4)
    // Estimate token usage (roughly 10,000 tokens for average PR review to protect Gemini limits)
    try {
      await QuotaService.checkAndReserveQuota(installationId, 10000);
    } catch (quotaError: any) {
      if (quotaError instanceof QuotaExceededError) {
        console.warn(`[Quota] Installation ${installationId} exhausted quota: ${quotaError.message}`);
        
        // Post a single rate-limit comment to GitHub (Phase 6)
        const github = new GitHubService(installationToken);
        const rateLimitMessage = `> [!WARNING]\n> **GitVerse AI Analysis Quota Exhausted**\n>\n> ${quotaError.message}\n> Analysis will resume automatically once the quota window resets.\n\n_Note: This is an automated message to prevent excessive API usage (Denial-of-Wallet protection)._`;
        
        try {
          // Check if we already posted a rate limit message for this PR recently to avoid spam
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
            const prRecord = await prisma.pullRequest.upsert({
              where: { repoId_prNumber: { repoId: enabledRepo.id, prNumber: number } },
              create: { repoId: enabledRepo.id, prNumber: number, title: "Unknown", author: "unknown", headSha: "rate-limited", htmlUrl: "", status: "OPEN" },
              update: {},
            });
            await prisma.pRReview.create({
              data: {
                pullRequestId: prRecord.id,
                headSha: "rate-limited-" + Date.now(),
                reviewText: rateLimitMessage,
                rawJson: { quota_exceeded: true },
              }
            });
          }
        } catch (postErr) {
          console.error("Failed to post quota warning to GitHub", postErr);
        }
        
        return completeWebhook("RATE_LIMITED", quotaError.message, NextResponse.json(
          { error: "Quota exceeded", message: quotaError.message },
          { status: 429 }
        ));
      }
      throw quotaError; // Re-throw other errors
    }

    const github = new GitHubService(installationToken);
    const pr = await github.getPullRequest(owner, repo, number);
    const headSha = pr?.head?.sha;
    if (!headSha) {
      return completeWebhook("FAILED", "Missing head SHA", NextResponse.json(
        {
          error: "Missing head SHA from GitHub PR response",
          details: { owner, repo, number },
        },
        { status: 500 }
      ));
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

    // Dedupe/lock: create a placeholder review row
    let reviewRow: {
      id: number;
      pullRequestId: number;
      headSha: string;
    } | null = null;
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
        return completeWebhook("COMPLETED", undefined, NextResponse.json(
          {
            ok: true,
            ignored: true,
            reason: "already_reviewed",
            repoFullName,
            prNumber: number,
            headSha,
          },
          { status: 200 }
        ));
      }
      throw e;
    }

    try {
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
        const posted = await github.postPullRequestComment(
          owner,
          repo,
          number,
          comment
        );
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
            _githubPost: {
              ok: Boolean(postedUrl),
              postedUrl,
              error: postError,
            },
          } as any,
        },
      });

      return completeWebhook("COMPLETED", undefined, NextResponse.json(
        {
          ok: true,
          posted: postedUrl,
          postError,
          stored: {
            pullRequestId: prRecord.id,
            prReviewId: reviewRow.id,
            headSha,
          },
        },
        { status: 200 }
      ));
    } catch (innerError: any) {
      if (reviewRow) {
        await prisma.pRReview
          .delete({
            where: { id: reviewRow.id },
          })
          .catch(() => null); // best-effort cleanup
      }
      throw innerError;
    }
  } catch (error: any) {
    console.error("GitHub webhook PR review error:", sanitizeError(error));
    return completeWebhook("FAILED", String(error), NextResponse.json(
      {
        error: "Failed to process PR webhook",
      },
      { status: 500 }
    ));
  }
}
