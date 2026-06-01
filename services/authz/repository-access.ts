import prisma from "../../lib/prisma";
import { RepositoryAccessResult, RepositoryRole } from "../../types/repository-permissions";

export class RepositoryAccess {
  /**
   * Validates a user's access rights to a repository.
   * Performs repository checks, ownership lookups, and organization-level RBAC role retrieval.
   */
  public static async checkAccess(
    repositoryId: number,
    userId: number
  ): Promise<RepositoryAccessResult> {
    try {
      // 1. Retrieve the repository
      const repository = await prisma.repository.findUnique({
        where: { id: repositoryId },
        select: { id: true, userId: true },
      });

      if (!repository) {
        return {
          allowed: false,
          repositoryExists: false,
          reason: "Repository not found",
        };
      }

      // 2. Personal ownership verification
      if (repository.userId === userId) {
        return {
          allowed: true,
          role: "REPO_ADMIN",
          repositoryExists: true,
        };
      }

      // 3. Organization association lookup
      const assignment = await prisma.repositoryPolicyAssignment.findUnique({
        where: { repositoryId },
        select: { organizationId: true },
      });

      if (!assignment) {
        // No organization assigned and user is not direct owner
        return {
          allowed: false,
          repositoryExists: true,
          reason: "Unauthorized access to repository",
        };
      }

      // 4. Organization membership check
      const membership = await prisma.organizationMember.findUnique({
        where: {
          organizationId_userId: {
            organizationId: assignment.organizationId,
            userId,
          },
        },
        select: { role: true },
      });

      if (!membership) {
        return {
          allowed: false,
          repositoryExists: true,
          reason: "User is not a member of the repository organization",
        };
      }

      const role = membership.role as RepositoryRole;

      return {
        allowed: true,
        role,
        repositoryExists: true,
      };
    } catch (error: any) {
      console.error("[RepositoryAccess] Error checking access rights:", error);
      return {
        allowed: false,
        repositoryExists: true,
        reason: `Authorization error: ${error.message || error}`,
      };
    }
  }
}
