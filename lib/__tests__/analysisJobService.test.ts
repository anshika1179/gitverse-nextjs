jest.mock("bullmq", () => {
  return {
    Queue: jest.fn().mockImplementation(() => ({
      add: jest.fn(),
    })),
    Worker: jest.fn(),
  };
});

jest.mock("ioredis", () => {
  return {
    Redis: jest.fn().mockImplementation(() => ({
      on: jest.fn(),
    })),
  };
});

import { AnalysisJobService } from "../services/analysisJobService";

describe("AnalysisJobService", () => {
  let service: AnalysisJobService;

  beforeEach(() => {
    service = new AnalysisJobService();
  });

  it("exports a singleton", () => {
    expect(typeof service.createRepositoryAnalysisJob).toBe("function");
    expect(typeof service.createArchitectureGenerationJob).toBe("function");
    expect(typeof service.updateProgress).toBe("function");
    expect(typeof service.markDone).toBe("function");
    expect(typeof service.markFailed).toBe("function");
    expect(typeof service.getJob).toBe("function");
  });
});
