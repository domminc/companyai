import type { CompanyState } from "./types";

export interface Store {
  load(): Promise<CompanyState | null>;
  save(state: CompanyState): Promise<void>;
}

export class MemoryStore implements Store {
  private data: CompanyState | null = null;
  async load() {
    return this.data ? structuredClone(this.data) : null;
  }
  async save(state: CompanyState) {
    this.data = structuredClone(state);
  }
}
