import prisma from "@/lib/prisma";

export class QuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaExceededError";
  }
}

export class QuotaService {
  // Configuration limits
  private static readonly MAX_REQUESTS_PER_WINDOW = 10;
  private static readonly WINDOW_DURATION_MS = 60 * 60 * 1000; // 1 hour

  /**
   * Enforces Installation-level quotas before calling Gemini.
   */
  static async checkAndReserveQuota(
    installationId: number | bigint,
    estimatedTokens: number = 0
  ): Promise<void> {
    const instId = BigInt(installationId);
    
    // We use a transaction to avoid race conditions during concurrent webhook deliveries
    await prisma.$transaction(async (tx) => {
      let quota = await tx.gitHubInstallationQuota.findUnique({
        where: { installationId: instId },
      });

      const now = new Date();

      if (!quota) {
        // Create first time quota
        quota = await tx.gitHubInstallationQuota.create({
          data: {
            installationId: instId,
            currentWindowStart: now,
            requestsUsed: 0,
            tokensUsed: 0,
            quotaStatus: "active",
          },
        });
      } else {
        // Check if window has expired and needs reset
        if (now.getTime() - quota.currentWindowStart.getTime() > this.WINDOW_DURATION_MS) {
          quota = await tx.gitHubInstallationQuota.update({
            where: { id: quota.id },
            data: {
              currentWindowStart: now,
              requestsUsed: 0,
              tokensUsed: 0,
              quotaStatus: "active",
            },
          });
        }
      }

      if (quota.quotaStatus !== "active") {
        throw new QuotaExceededError("Your AI analysis quota is suspended or exhausted.");
      }

      if (quota.requestsUsed >= this.MAX_REQUESTS_PER_WINDOW) {
        // Mark as exhausted
        await tx.gitHubInstallationQuota.update({
          where: { id: quota.id },
          data: { quotaStatus: "exhausted" },
        });
        throw new QuotaExceededError(`Exceeded maximum of ${this.MAX_REQUESTS_PER_WINDOW} requests per hour.`);
      }

      // Reserve the quota
      await tx.gitHubInstallationQuota.update({
        where: { id: quota.id },
        data: {
          requestsUsed: { increment: 1 },
          tokensUsed: { increment: estimatedTokens },
          lastRequestAt: now,
        },
      });
    });
  }
}
