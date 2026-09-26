import { useEffect, useReducer, useState } from "react";
import type { CompanyEvent, CompanyState } from "../../engine/types";
import { api, type ModelOption } from "./api";

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

export function reduce(state: CompanyState | null, event: CompanyEvent): CompanyState | null {
  if (event.type === "state") return event.state;
  if (!state) return state;
  switch (event.type) {
    case "company.updated":
      return { ...state, name: event.name, mission: event.mission, defaultModel: event.defaultModel };
    case "agent.updated":
      return { ...state, agents: upsert(state.agents, event.agent) };
    case "gateways.updated":
      return { ...state, gateways: event.gateways };
    case "agent.fired":
      return { ...state, agents: state.agents.filter((a) => a.id !== event.agentId) };
    case "task.updated":
      return { ...state, tasks: upsert(state.tasks, event.task) };
    case "task.deleted":
      return { ...state, tasks: state.tasks.filter((t) => t.id !== event.taskId) };
    case "task.delta":
      return {
        ...state,
        tasks: state.tasks.map((t) => (t.id === event.taskId ? { ...t, output: t.output + event.text } : t)),
      };
    case "meeting.updated":
      return { ...state, meetings: upsert(state.meetings, event.meeting) };
    case "meeting.delta":
      return {
        ...state,
        meetings: state.meetings.map((m) =>
          m.id !== event.meetingId
            ? m
            : {
                ...m,
                transcript: m.transcript.map((e) =>
                  e.id === event.entryId && e.kind === "speech" ? { ...e, content: e.content + event.text } : e,
                ),
              },
        ),
      };
    case "activity":
      return { ...state, activity: [...state.activity, event.entry].slice(-200) };
  }
}

export interface CompanyStore {
  state: CompanyState | null;
  provider: string;
  models: ModelOption[];
  connected: boolean;
}

/** Live company state: initial snapshot over REST, then the SSE event stream. */
export function useCompany(): CompanyStore {
  const [state, dispatch] = useReducer(reduce, null);
  const [meta, setMeta] = useState<{ provider: string; models: ModelOption[] }>({ provider: "", models: [] });
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    api.bootstrap().then(({ provider, models }) => setMeta({ provider, models }), () => {});
    // The stream opens with a full `state` event, so reconnects resync on their own.
    const source = new EventSource("/api/events");
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (msg) => dispatch(JSON.parse(msg.data) as CompanyEvent);
    return () => source.close();
  }, []);

  return { state, connected, ...meta };
}
