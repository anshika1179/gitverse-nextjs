"use client";

import {
  GitBranch,
  Star,
  GitFork,
  Eye,
  Clock,
  Users,
  Code,
  FileText,
  Activity,
  TrendingUp,
  ExternalLink,
} from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui";
import { Button } from "@/components/ui";
import { useState } from "react";
import { buildApiUrl } from "@/services/apiConfig";

interface RepositoryData {
  id: string;
  name: string;
  fullName: string;
  url: string;
  description: string;
  stars: number;
  forks: number;
  watchers: number;
  language: string;
  createdAt: string;
  updatedAt: string;
  size: number;
  defaultBranch: string;
  openIssues: number;
  license?: string;
}

interface RepositoryOverviewProps {
  repositoryData?: any;
}

export const RepositoryOverview = ({
  repositoryData,
}: RepositoryOverviewProps) => {
  const [readmeText, setReadmeText] = useState<string | null>(
    repositoryData?.readmeText ?? null,
  );
  const [readmePath, setReadmePath] = useState<string | null>(
    repositoryData?.readmePath ?? null,
  );
  const [isFetchingReadme, setIsFetchingReadme] = useState(false);

  // Calculate total lines of code from languages only
  const totalLines =
    repositoryData?.languages?.reduce(
      (sum: number, lang: any) => sum + (lang.lines || 0),
      0,
    ) || 0;

  // Use real repository data
  const repository: RepositoryData = {
    id: repositoryData?.id?.toString() || "0",
    name: repositoryData?.name || "Unknown",
    fullName: repositoryData?.fullName || repositoryData?.name || "Unknown",
    url: repositoryData?.url || "#",
    description: repositoryData?.description || "No description available",
    stars: repositoryData?.stars || 0,
    forks: repositoryData?.forks || 0,
    watchers: repositoryData?.watchers || 0,
    language:
      repositoryData?.languages?.[0]?.name ||
      repositoryData?.primaryLanguage ||
      "Unknown",
    createdAt: repositoryData?.createdAt || new Date().toISOString(),
    updatedAt: repositoryData?.analyzedAt
      ? new Date(repositoryData.analyzedAt).toLocaleString()
      : "Unknown",
    size: repositoryData?.size || 0,
    defaultBranch: repositoryData?.defaultBranch || "main",
    openIssues: repositoryData?.openIssues || 0,
    license: repositoryData?.license || undefined,
  };

  const stats = [
    {
      label: "Total Commits",
      value: repositoryData?.commits?.length?.toString() || "0",
      icon: Activity,
      trend: `Default: ${repositoryData?.defaultBranch || "main"}`,
    },
    {
      label: "Contributors",
      value: repositoryData?.contributors?.length?.toString() || "0",
      icon: Users,
      trend: `${repositoryData?.contributors?.filter((c: any) => c.commits > 0)?.length || 0} active`,
    },
    {
      label: "Lines of Code",
      value:
        totalLines > 1000000
          ? `${(totalLines / 1000000).toFixed(1)}M`
          : totalLines > 1000
            ? `${(totalLines / 1000).toFixed(1)}K`
            : totalLines.toString(),
      icon: Code,
      trend: `${repositoryData?.languages?.length || 0} languages`,
    },
    {
      label: "Files",
      value: repositoryData?.files?.length?.toString() || "0",
      icon: FileText,
      trend: `${(repositoryData?.size || 0) / 1024 < 1 ? "<1" : ((repositoryData?.size || 0) / 1024).toFixed(0)} KB`,
    },
  ];

  const getLanguageColor = (name: string) => {
    const colors: Record<string, string> = {
      TypeScript: "bg-blue-500",
      JavaScript: "bg-yellow-500",
      Python: "bg-green-500",
      Java: "bg-red-500",
      CSS: "bg-purple-500",
      HTML: "bg-orange-500",
      Go: "bg-cyan-500",
      Rust: "bg-orange-600",
      Ruby: "bg-red-600",
    };
    return colors[name] || "bg-gray-500";
  };

  const languages = (repositoryData?.languages || []).map((lang: any) => ({
    name: lang.name,
    percentage: lang.percentage,
    color: getLanguageColor(lang.name),
  }));

  const fetchReadme = async () => {
    if (!repositoryData?.id) return;
    setIsFetchingReadme(true);
    try {
      const token =
        typeof window !== "undefined"
          ? localStorage.getItem("gitverse_token")
          : null;

      const res = await fetch(
        buildApiUrl(`/api/repositories/${repositoryData.id}/readme`),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        },
      );

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || "Failed to fetch README");
      }

      setReadmeText(data?.repository?.readmeText ?? null);
      setReadmePath(data?.repository?.readmePath ?? null);
    } finally {
      setIsFetchingReadme(false);
    }
  };

  const formatTimeAgo = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffInHours = Math.floor(
      (now.getTime() - date.getTime()) / (1000 * 60 * 60),
    );

    if (diffInHours < 1) return "Just now";
    if (diffInHours < 24) return `${diffInHours}h ago`;
    if (diffInHours < 48) return "Yesterday";
    const diffInDays = Math.floor(diffInHours / 24);
    if (diffInDays < 7) return `${diffInDays}d ago`;
    return date.toLocaleDateString();
  };

  const recentActivity = (repositoryData?.commits || [])
    .slice(0, 4)
    .map((commit: any) => ({
      type: "commit",
      user: commit.authorName || "Unknown",
      message: commit.message || "No message",
      time: formatTimeAgo(commit.committedAt || commit.createdAt),
    }));

  return (
    <div className="space-y-6">
      {/* Repository Header */}
      <div className="glass rounded-lg p-4 sm:p-6">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4 mb-4">
          <div className="flex-1 min-w-0">
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 mb-2 flex-wrap">
              <GitBranch className="h-5 w-5 sm:h-6 sm:w-6 text-primary flex-shrink-0" />
              <h1 className="text-2xl sm:text-3xl font-heading font-bold truncate">
                {repository.name}
              </h1>
              <span className="px-2 py-1 rounded-full text-xs bg-accent/10 text-accent flex-shrink-0">
                {repository.language}
              </span>
            </div>
            <p className="text-xs sm:text-sm text-muted-foreground mb-3 break-words">
              {repository.description}
            </p>
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 text-xs sm:text-sm text-muted-foreground flex-wrap">
              <a
                href={repository.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 hover:text-primary transition-colors"
              >
                <ExternalLink className="h-4 w-4" />
                {repository.fullName}
              </a>
              {repository.license && (
                <span className="flex items-center gap-1">
                  <FileText className="h-4 w-4" />
                  {repository.license}
                </span>
              )}
              <span className="flex items-center gap-1">
                <Clock className="h-4 w-4" />
                Updated {repository.updatedAt}
              </span>
            </div>
          </div>
        </div>

        {/* Quick Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 pt-4 border-t border-border/50">
          <div className="flex items-center gap-2">
            <Star className="h-4 w-4 sm:h-5 sm:w-5 text-yellow-500 flex-shrink-0" />
            <div className="min-w-0">
              <div className="text-lg sm:text-xl font-bold">
                {repository.stars}
              </div>
              <div className="text-xs text-muted-foreground">Stars</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <GitFork className="h-4 w-4 sm:h-5 sm:w-5 text-primary flex-shrink-0" />
            <div className="min-w-0">
              <div className="text-lg sm:text-xl font-bold">
                {repository.forks}
              </div>
              <div className="text-xs text-muted-foreground">Forks</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Eye className="h-4 w-4 sm:h-5 sm:w-5 text-accent flex-shrink-0" />
            <div className="min-w-0">
              <div className="text-lg sm:text-xl font-bold">
                {repository.watchers}
              </div>
              <div className="text-xs text-muted-foreground">Watchers</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 sm:h-5 sm:w-5 text-destructive flex-shrink-0" />
            <div className="min-w-0">
              <div className="text-lg sm:text-xl font-bold">
                {repository.openIssues}
              </div>
              <div className="text-xs text-muted-foreground">Issues</div>
            </div>
          </div>
        </div>
      </div>

      {/* Repository Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        {stats.map((stat, index) => (
          <Card
            key={stat.label}
            className="glass glass-hover"
            style={{ animationDelay: `${index * 0.1}s` }}
          >
            <CardContent className="pt-4 sm:pt-6">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <p className="text-xs sm:text-sm text-muted-foreground mb-1">
                    {stat.label}
                  </p>
                  <p className="text-2xl sm:text-3xl font-heading font-bold">
                    {stat.value}
                  </p>
                  <p className="text-xs text-accent mt-1 flex items-center gap-1 truncate">
                    <TrendingUp className="h-3 w-3 flex-shrink-0" />
                    <span className="truncate">{stat.trend}</span>
                  </p>
                </div>
                <div className="p-2 sm:p-3 rounded-lg bg-primary/10 flex-shrink-0">
                  <stat.icon className="h-4 w-4 sm:h-5 sm:w-5 text-primary" />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
        {/* Language Breakdown */}
        <Card className="lg:col-span-2 glass">
          <CardHeader className="p-4 sm:p-6">
            <CardTitle className="font-heading text-lg sm:text-xl">
              Language Breakdown
            </CardTitle>
            <CardDescription className="text-xs sm:text-sm">
              Code distribution by programming language
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 sm:space-y-4 p-4 sm:p-6 pt-0 sm:pt-0">
            {languages.map((lang: any) => (
              <div key={lang.name}>
                <div className="flex items-center justify-between mb-2 gap-2">
                  <span className="text-xs sm:text-sm font-medium truncate">
                    {lang.name}
                  </span>
                  <span className="text-xs sm:text-sm text-muted-foreground flex-shrink-0">
                    {lang.percentage}%
                  </span>
                </div>
                <div className="w-full bg-muted rounded-full h-2">
                  <div
                    className={`${lang.color} h-2 rounded-full transition-all`}
                    style={{ width: `${lang.percentage}%` }}
                  />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Recent Activity */}
        <Card className="glass">
          <CardHeader className="p-4 sm:p-6">
            <CardTitle className="font-heading text-lg sm:text-xl">
              Recent Activity
            </CardTitle>
            <CardDescription className="text-xs sm:text-sm">
              Latest updates
            </CardDescription>
          </CardHeader>
          <CardContent className="p-4 sm:p-6 pt-0 sm:pt-0">
            <div className="space-y-3 sm:space-y-4">
              {recentActivity.map((activity: any, index: number) => (
                <div key={index} className="flex items-start gap-2 sm:gap-3">
                  <div className="mt-1 p-1.5 rounded-full bg-accent/10 flex-shrink-0">
                    <Activity className="h-3 w-3 text-accent" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs sm:text-sm">
                      <span className="font-medium">{activity.user}</span>{" "}
                      <span className="text-muted-foreground break-words">
                        {activity.message}
                      </span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {activity.time}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* README */}
      <div className="grid grid-cols-1 gap-4 sm:gap-6">
        <Card className="glass">
          <CardHeader className="p-4 sm:p-6">
            <CardTitle className="font-heading text-lg sm:text-xl">
              README
            </CardTitle>
            <CardDescription className="text-xs sm:text-sm">
              {readmePath
                ? `Showing ${readmePath}`
                : "Fetch and view the repository README"}
            </CardDescription>
          </CardHeader>
          <CardContent className="p-4 sm:p-6 pt-0 sm:pt-0 space-y-3">
            {readmeText ? (
              <pre className="whitespace-pre-wrap text-xs sm:text-sm leading-relaxed bg-background/50 border border-border/50 rounded-lg p-3 max-h-96 overflow-auto">
                {readmeText}
              </pre>
            ) : (
              <div className="text-sm text-muted-foreground">
                No README stored yet.
              </div>
            )}

            <div className="flex items-center gap-2">
              <Button
                type="button"
                onClick={fetchReadme}
                disabled={isFetchingReadme}
                className="bg-gradient-primary"
              >
                {isFetchingReadme ? "Fetching…" : "Fetch README"}
              </Button>
              <span className="text-xs text-muted-foreground">
                Stored in DB for faster reuse.
              </span>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};
