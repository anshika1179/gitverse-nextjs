"use client";

import { useMemo, useState } from "react";
import { Bot, Loader2, Send, Sparkles } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Button,
} from "@/components/ui";
import { buildApiUrl } from "@/services/apiConfig";

type Role = "user" | "assistant";

type MentorMessage = {
  role: Role;
  content: string;
};

function buildMentorPrompt(args: {
  repoName: string;
  description?: string;
  languages: string[];
  readmeText?: string | null;
  conversation: MentorMessage[];
  question: string;
}): string {
  const history = args.conversation
    .slice(-6)
    .map((m) => `${m.role === "user" ? "User" : "Mentor"}: ${m.content}`)
    .join("\n\n");

  const readme = (args.readmeText || "").trim();
  const readmeBlock = readme
    ? `\n\n===== README (${Math.min(readme.length, 200000)} chars) =====\n${readme}\n===== END README =====`
    : "\n\n(README not available yet.)";

  return `You are an AI Mentor helping a developer understand and work with a repository.

===== REPO CONTEXT =====
Name: ${args.repoName}
${args.description ? `Description: ${args.description}` : ""}
Languages: ${args.languages.join(", ") || "Unknown"}
${readmeBlock}

===== BEHAVIOR =====
- Prefer answers grounded in the README and the languages list.
- If the README is missing, say what info is missing and give best-effort general guidance.
- Be concise and actionable.

${history ? `===== RECENT CHAT =====\n${history}\n\n` : ""}User Question: ${args.question}`;
}

export function AIRepoMentorSection(props: {
  repositoryId: number;
  repoName: string;
  description?: string;
  languages: string[];
  readmeText?: string | null;
  disabled?: boolean;
  disabledHint?: string;
}) {
  const presets = useMemo(
    () => [
      "How do I set this up locally?",
      "What is the tech stack in this repo?",
      "Where should I start if I want to contribute?",
      "How do I run tests and linting?",
    ],
    [],
  );

  const [messages, setMessages] = useState<MentorMessage[]>([
    {
      role: "assistant",
      content:
        "Ask me about setup, tech stack, or where to start — I’ll use the README + languages as context.",
    },
  ]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const send = async (question: string) => {
    const trimmed = question.trim();
    if (!trimmed || isLoading || props.disabled) return;

    const userMessage: MentorMessage = { role: "user", content: trimmed };
    const nextConversation: MentorMessage[] = [...messages, userMessage];
    setMessages(nextConversation);
    setInput("");
    setIsLoading(true);

    try {
      const prompt = buildMentorPrompt({
        repoName: props.repoName,
        description: props.description,
        languages: props.languages,
        readmeText: props.readmeText,
        conversation: nextConversation,
        question: trimmed,
      });

      const token =
        typeof window !== "undefined"
          ? localStorage.getItem("gitverse_token")
          : null;

      const res = await fetch(buildApiUrl("/api/ai/chat"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ repositoryId: props.repositoryId, prompt }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          data?.error || data?.details || "Failed to get AI response",
        );
      }

      const text = typeof data?.response === "string" ? data.response : "";
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: text || "I couldn't generate a response. Please try again.",
        },
      ]);
    } catch (e: any) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: e?.message || "Something went wrong. Please try again.",
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Card className="glass">
      <CardHeader className="p-4 sm:p-6">
        <CardTitle className="font-heading text-lg sm:text-xl flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-accent" />
          AI Mentor
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 sm:p-6 pt-0 sm:pt-0 space-y-4">
        {props.disabled && (
          <div className="text-xs text-muted-foreground">
            {props.disabledHint ||
              "Preparing context (fetching README) before enabling chat…"}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {presets.map((q) => (
            <Button
              key={q}
              type="button"
              variant="outline"
              className="text-xs"
              onClick={() => send(q)}
              disabled={isLoading || props.disabled}
            >
              {q}
            </Button>
          ))}
        </div>

        <div className="rounded-lg border border-border/50 bg-background/50 overflow-hidden">
          <div className="max-h-72 overflow-y-auto p-3 sm:p-4 space-y-3">
            {messages.map((m, idx) => (
              <div
                key={idx}
                className={`flex gap-2 ${m.role === "user" ? "justify-end" : "justify-start"}`}
              >
                {m.role === "assistant" && (
                  <div className="mt-0.5 h-7 w-7 rounded-full bg-primary/15 flex items-center justify-center flex-shrink-0">
                    <Bot className="h-4 w-4 text-primary" />
                  </div>
                )}
                <div
                  className={`max-w-[85%] rounded-lg px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap ${
                    m.role === "user"
                      ? "bg-primary/15"
                      : "bg-white/5 border border-white/10"
                  }`}
                >
                  {m.content}
                </div>
              </div>
            ))}
          </div>

          <div className="border-t border-border/50 p-3 sm:p-4">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send(input);
              }}
              className="flex gap-2"
            >
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask about setup, scripts, architecture…"
                className="flex-1 glass px-3 py-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50"
                disabled={isLoading || props.disabled}
              />
              <Button
                type="submit"
                disabled={!input.trim() || isLoading || props.disabled}
              >
                {isLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <span className="inline-flex items-center gap-2">
                    <Send className="h-4 w-4" />
                    <span className="hidden sm:inline">Send</span>
                  </span>
                )}
              </Button>
            </form>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
