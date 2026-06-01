import { RepositoryAccess } from "../../../services/authz/repository-access";
import { RBAC } from "../../../services/authz/rbac";
import prisma from "../../../lib/prisma";

jest.mock("../../../lib/prisma", () => ({
  __esModule: true,
  default: {
    repository: {
      findUnique: jest.fn(),
    },
    repositoryPolicyAssignment: {
      findUnique: jest.fn(),
    },
    organizationMember: {
      findUnique: jest.fn(),
    },
  },
}));

describe("Repository IDOR & RBAC Authorization Engine", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("RBAC Role Validation Checks", () => {
    it("allows ORG_ADMIN and REPO_ADMIN to modify policy", () => {
      expect(RBAC.canModifyPolicy("ORG_ADMIN")).toBe(true);
      expect(RBAC.canModifyPolicy("REPO_ADMIN")).toBe(true);
    });

    it("rejects CONTRIBUTOR and VIEWER from modifying policy", () => {
      expect(RBAC.canModifyPolicy("CONTRIBUTOR")).toBe(false);
      expect(RBAC.canModifyPolicy("VIEWER")).toBe(false);
    });

    it("allows all registered roles to read policy", () => {
      const roles = ["ORG_ADMIN", "REPO_ADMIN", "CONTRIBUTOR", "VIEWER"] as const;
      for (const role of roles) {
        expect(RBAC.canReadPolicy(role)).toBe(true);
      }
    });
  });

  describe("RepositoryAccess Checks", () => {
    const targetRepoId = 101;
    const directOwnerId = 999;
    const nonOwnerId = 555;
    const orgId = "org-uuid-123";

    it("Scenario 1: allows direct personal owner (implicitly REPO_ADMIN)", async () => {
      (prisma.repository.findUnique as jest.Mock).mockResolvedValue({
        id: targetRepoId,
        userId: directOwnerId,
      });

      const result = await RepositoryAccess.checkAccess(targetRepoId, directOwnerId);
      expect(result.allowed).toBe(true);
      expect(result.role).toBe("REPO_ADMIN");
      expect(result.repositoryExists).toBe(true);
    });

    it("Scenario 2: allows Org Admin to access repository policy", async () => {
      (prisma.repository.findUnique as jest.Mock).mockResolvedValue({
        id: targetRepoId,
        userId: directOwnerId, // Repository owned by directOwnerId
      });
      (prisma.repositoryPolicyAssignment.findUnique as jest.Mock).mockResolvedValue({
        organizationId: orgId,
      });
      (prisma.organizationMember.findUnique as jest.Mock).mockResolvedValue({
        role: "ORG_ADMIN",
      });

      const result = await RepositoryAccess.checkAccess(targetRepoId, nonOwnerId);
      expect(result.allowed).toBe(true);
      expect(result.role).toBe("ORG_ADMIN");
      expect(result.repositoryExists).toBe(true);
    });

    it("Scenario 3: rejects Contributor from administrative authorization (RBAC block will check role)", async () => {
      (prisma.repository.findUnique as jest.Mock).mockResolvedValue({
        id: targetRepoId,
        userId: directOwnerId,
      });
      (prisma.repositoryPolicyAssignment.findUnique as jest.Mock).mockResolvedValue({
        organizationId: orgId,
      });
      (prisma.organizationMember.findUnique as jest.Mock).mockResolvedValue({
        role: "CONTRIBUTOR",
      });

      const result = await RepositoryAccess.checkAccess(targetRepoId, nonOwnerId);
      expect(result.allowed).toBe(true);
      expect(result.role).toBe("CONTRIBUTOR");
      // RBAC will block modifying action:
      expect(RBAC.canModifyPolicy(result.role!)).toBe(false);
    });

    it("Scenario 4: blocks user from another organization from modifying/viewing", async () => {
      (prisma.repository.findUnique as jest.Mock).mockResolvedValue({
        id: targetRepoId,
        userId: directOwnerId,
      });
      (prisma.repositoryPolicyAssignment.findUnique as jest.Mock).mockResolvedValue({
        organizationId: orgId,
      });
      // User is not a member of the organization
      (prisma.organizationMember.findUnique as jest.Mock).mockResolvedValue(null);

      const result = await RepositoryAccess.checkAccess(targetRepoId, nonOwnerId);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("User is not a member");
    });

    it("Scenario 5: blocks repository enumeration gracefully", async () => {
      // Mock repository not found
      (prisma.repository.findUnique as jest.Mock).mockResolvedValue(null);

      const result = await RepositoryAccess.checkAccess(9999, nonOwnerId);
      expect(result.allowed).toBe(false);
      expect(result.repositoryExists).toBe(false);
      expect(result.reason).toBe("Repository not found");
    });
  });
});
