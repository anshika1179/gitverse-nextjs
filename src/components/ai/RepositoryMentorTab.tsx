"use client";

import { useMemo } from "react";
import { AIRepoMentorSection } from "@/components/ai/AIRepoMentorSection";

export function RepositoryMentorTab(props: { repositoryData?: any }) {
  const repositoryData = props.repositoryData;

  const repoName: string = repositoryData?.name || "Unknown";
  const description: string | undefined =
    repositoryData?.description || undefined;

  const languageNames = useMemo(
    () =>
      (repositoryData?.languages || [])
        .map((l: any) => l?.name)
        .filter(Boolean),
    [repositoryData?.languages],
  );

  const readmeText: string | null = repositoryData?.readmeText ?? null;

  return (
    <div className="space-y-6">
      <AIRepoMentorSection
        repositoryId={Number(repositoryData?.id || 0)}
        repoName={repoName}
        description={description}
        languages={languageNames}
        readmeText={readmeText}
      />
    </div>
  );
}
