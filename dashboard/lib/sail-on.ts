/**
 * Where a voyage can sail: "hub" (this machine), "laptop" (lib/laptop-host.ts),
 * or "exe" (an exe.dev VM, lib/exe-voyages.ts), as the Set a course form and
 * voyage_start name them. One list, so the Go gate's argument check and the
 * shipyard cannot drift apart (the gate once refused "exe" after the shipyard took it).
 */
export const SAIL_ON = ["hub", "laptop", "exe"] as const;
