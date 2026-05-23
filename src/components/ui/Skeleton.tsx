import { cn } from "@/lib/utils";
// The Skeleton.tsx import update was required because the previous `@/utils/cn` path no longer exists and caused a TypeScript module resolution error.

function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-muted/60", className)}
      {...props}
    />
  );
}

export { Skeleton };
