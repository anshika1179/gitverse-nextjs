import prisma from "../prisma";
import type { AnalysisJob } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { isRetryableError, computeBackoffMs } from "../utils/retry";

export type JobProgressUpdate = {
  progressPercent?: number;
  progressMessage?: string;
  progressDetails?: unknown;
};

const DEFAULT_LOCK_MS = 5 * 60 * 1000;

export class AnalysisJobService {
  async createRepositoryAnalysisJob(params: {
    repositoryId: number;
    userId: number;
    maxAttempts?: number;
    scope?: string;
  }): Promise<AnalysisJob> {
    return prisma.$transaction(async (tx) => {
      const existing = await tx.analysisJob.findFirst({
        where: {
          repositoryId: params.repositoryId,
          status: { in: ["QUEUED", "PROCESSING"] },
        },
      });
      if (existing) return existing;

      try {
        return await tx.analysisJob.create({
          data: {
            repositoryId: params.repositoryId,
            userId: params.userId,
            type: "repository_analysis",
            status: "QUEUED",
            progressPercent: 0,
            progressMessage: "Queued",
            progressDetails: params.scope ? { scope: params.scope } : undefined,
            maxAttempts: params.maxAttempts ?? 3,
          },
        });
      } catch (error: any) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          const activeJob = await tx.analysisJob.findFirst({
            where: {
              repositoryId: params.repositoryId,
              status: { in: ["QUEUED", "PROCESSING"] },
            },
          });
          if (activeJob) return activeJob;
        }
        throw error;
      }
    });
  }

  async getJob(params: {
    jobId: string;
    userId: number;
  }): Promise<AnalysisJob | null> {
    return prisma.analysisJob.findFirst({
      where: {
        id: params.jobId,
        userId: params.userId,
      },
    });
  }

  async updateProgress(params: {
    jobId: string;
    workerId?: string;
    update: JobProgressUpdate;
    extendLockMs?: number;
  }): Promise<void> {
    const lockExtension = params.extendLockMs ?? DEFAULT_LOCK_MS;

    const pct = params.update.progressPercent !== undefined
      ? Math.max(0, Math.min(100, Math.round(params.update.progressPercent)))
      : undefined;

    const where: any = { id: params.jobId };
    if (params.workerId) {
      where.lockedBy = params.workerId;
    }

    await prisma.analysisJob.update({
      where,
      data: {
        progressPercent: pct,
        progressMessage: params.update.progressMessage,
        progressDetails: params.update.progressDetails as any,
        ...(params.workerId
          ? {
              lockExpiresAt: new Date(Date.now() + lockExtension),
            }
          : {}),
      },
    });
  }

  async markDone(params: { jobId: string; workerId?: string }): Promise<void> {
    const where: any = { id: params.jobId };
    if (params.workerId) {
      where.lockedBy = params.workerId;
    }

    await prisma.analysisJob.update({
      where,
      data: {
        status: "DONE",
        progressPercent: 100,
        progressMessage: "Analysis complete! ✓",
        finishedAt: new Date(),
        error: null,
        lockedAt: null,
        lockedBy: null,
        lockExpiresAt: null,
      },
    });
  }

  async markFailed(params: {
    jobId: string;
    workerId?: string;
    error: string;
    attempts: number;
    maxAttempts: number;
  }): Promise<void> {
    const where: any = { id: params.jobId };
    if (params.workerId) {
      where.lockedBy = params.workerId;
    }

    const shouldRetry =
      params.attempts < params.maxAttempts &&
      isRetryableError(params.error);
    if (shouldRetry) {
      const delay = computeBackoffMs(params.attempts);
      await prisma.analysisJob.update({
        where,
        data: {
          status: "QUEUED",
          nextRunAt: new Date(Date.now() + delay),
          progressMessage: `Retrying in ${Math.round(delay / 1000)}s`,
          error: params.error,
          lockedAt: null,
          lockedBy: null,
          lockExpiresAt: null,
        },
      });
      return;
    }

    await prisma.analysisJob.update({
      where,
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        progressMessage: "Analysis failed. Please try again.",
        progressPercent: null,
        error: params.error,
        lockedAt: null,
        lockedBy: null,
        lockExpiresAt: null,
      },
    });
  }

  async claimNextJob(params: {
    workerId: string;
    lockMs?: number;
  }): Promise<AnalysisJob | null> {
    const lockMs = params.lockMs ?? DEFAULT_LOCK_MS;

    return prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id
        FROM analysis_jobs
        WHERE next_run_at <= NOW()
          AND status IN ('QUEUED', 'PROCESSING')
          AND (lock_expires_at IS NULL OR lock_expires_at < NOW())
          AND NOT EXISTS (
            SELECT 1 FROM analysis_jobs a2
            WHERE a2.repository_id = analysis_jobs.repository_id
              AND a2.status = 'PROCESSING'
              AND a2.id != analysis_jobs.id
              AND (a2.lock_expires_at IS NULL OR a2.lock_expires_at > NOW())
          )
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `;

      if (!rows.length) return null;
      const claimedId = rows[0].id;

      const candidate = await tx.analysisJob.findUnique({ where: { id: claimedId } });
      if (!candidate) return null;

      const updated = await tx.analysisJob.update({
        where: { id: claimedId },
        data: {
          status: "PROCESSING",
          lockedAt: new Date(),
          lockedBy: params.workerId,
          lockExpiresAt: new Date(Date.now() + lockMs),
          attempts: { increment: 1 },
          startedAt: candidate.startedAt ?? new Date(),
          updatedAt: new Date(),
          progressMessage: candidate.progressMessage ?? 'Analysis in progress...',
          progressPercent: candidate.progressPercent ?? 0,
        }
      });
      return updated;
    });
  }

  async cleanupStaleJobs(): Promise<number> {
    const stale = await prisma.analysisJob.updateMany({
      where: {
        status: "PROCESSING",
        OR: [
          { lockExpiresAt: { lt: new Date() } },
          { lockExpiresAt: null }
        ],
        updatedAt: { lt: new Date(Date.now() - 60 * 60 * 1000) },
      },
      data: {
        status: "FAILED",
        error: "Job timed out - no heartbeat received",
        progressMessage: "Job timed out - no heartbeat received",
        progressPercent: null,
        finishedAt: new Date(),
        lockedAt: null,
        lockedBy: null,
        lockExpiresAt: null,
      },
    });
    return stale.count;
  }

  async heartbeat(params: {
    jobId: string;
    workerId: string;
    lockMs?: number;
  }): Promise<void> {
    const lockMs = params.lockMs ?? DEFAULT_LOCK_MS;
    await prisma.$executeRaw`
      UPDATE analysis_jobs
      SET
        lock_expires_at = NOW() + (${lockMs}::int * INTERVAL '1 millisecond'),
        locked_by = ${params.workerId},
        updated_at = NOW()
      WHERE id = ${params.jobId}::uuid
        AND status = 'PROCESSING'
        AND locked_by = ${params.workerId}
    `;
  }
}

export const analysisJobService = new AnalysisJobService();
