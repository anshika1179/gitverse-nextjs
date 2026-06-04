import prisma from "../prisma";
import type { AnalysisJob } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { isRetryableError, computeBackoffMs } from "../utils/retry";
import { analysisQueue } from "../queue/analysisQueue";

export type JobProgressUpdate = {
  progressPercent?: number;
  progressMessage?: string;
  progressDetails?: unknown;
};

const DEFAULT_LOCK_MS = 5 * 60 * 1000;

export class AnalysisJobService {


  async getAnalysisStats(params: { userId: number }): Promise<{
    total: number;
    processing: number;
    queued: number;
    done: number;
    failed: number;
    stuck: number;
  }> {
    const [total, processing, queued, done, failed] =
      await Promise.all([
        prisma.analysisJob.count({ where: { userId: params.userId } }),
        prisma.analysisJob.count({
          where: { userId: params.userId, status: "PROCESSING" },
        }),
        prisma.analysisJob.count({
          where: { userId: params.userId, status: "QUEUED" },
        }),
        prisma.analysisJob.count({
          where: { userId: params.userId, status: "DONE" },
        }),
        prisma.analysisJob.count({
          where: { userId: params.userId, status: "FAILED" },
        }),
      ]);
    return { total, processing, queued, done, failed, stuck: 0 };
  }

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
        const job = await tx.analysisJob.create({
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
        await analysisQueue.add("repository_analysis", { jobId: job.id, userId: params.userId });
        return job;
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

  async createArchitectureGenerationJob(params: {
    repositoryId: number;
    userId: number;
    maxAttempts?: number;
  }): Promise<AnalysisJob> {
    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(${params.repositoryId})`;

      const existing = await tx.analysisJob.findFirst({
        where: {
          repositoryId: params.repositoryId,
          type: "architecture_generation",
          status: { in: ["QUEUED", "PROCESSING"] },
        },
      });
      if (existing) return existing;

      try {
        const job = await tx.analysisJob.create({
          data: {
            repositoryId: params.repositoryId,
            userId: params.userId,
            type: "architecture_generation",
            status: "QUEUED",
            progressPercent: 0,
            progressMessage: "Queued",
            maxAttempts: params.maxAttempts ?? 3,
          },
        });
        await analysisQueue.add("architecture_generation", { jobId: job.id, userId: params.userId });
        return job;
      } catch (error: any) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          const activeJob = await tx.analysisJob.findFirst({
            where: {
              repositoryId: params.repositoryId,
              type: "architecture_generation",
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
    const job = await prisma.analysisJob.findUnique({
      where: {
        id: params.jobId,
      },
      include: {
        repository: {
          select: { userId: true },
        },
      },
    });

    if (!job) return null;

    let hasAccess = false;

    // 1. User is the creator of the job
    if (job.userId === params.userId) {
      hasAccess = true;
    } 
    // 2. User is the owner of the repository
    else if (job.repository.userId === params.userId) {
      hasAccess = true;
    } 
    // 3. User has access via organization membership
    else {
      const orgAccess = await prisma.repositoryPolicyAssignment.findFirst({
        where: {
          repositoryId: job.repositoryId,
          organization: {
            members: {
              some: { userId: params.userId },
            },
          },
        },
      });

      if (orgAccess) {
        hasAccess = true;
      }
    }

    if (!hasAccess) {
      return null;
    }

    // Strip the joined repository to match the expected return type
    const { repository, ...jobData } = job as any;
    return jobData as AnalysisJob;
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

}

export const analysisJobService = new AnalysisJobService();
