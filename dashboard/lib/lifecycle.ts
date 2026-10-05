export type LifecycleState =
  | "stopped"
  | "starting"
  | "open"
  | "stopping"
  | "error";

export type AgentLifecycle = {
  state: LifecycleState;
  message?: string;
  updatedAt: string;
};

const store = new Map<string, AgentLifecycle>();

export function getLifecycle(agentId: string): AgentLifecycle | null {
  return store.get(agentId) ?? null;
}

export function setLifecycle(
  agentId: string,
  state: LifecycleState,
  message?: string,
): void {
  store.set(agentId, {
    state,
    message,
    updatedAt: new Date().toISOString(),
  });
}

export function clearLifecycleMessage(agentId: string): void {
  const cur = store.get(agentId);
  if (cur) store.set(agentId, { ...cur, message: undefined });
}

export function allLifecycle(): Record<string, AgentLifecycle> {
  return Object.fromEntries(store.entries());
}
