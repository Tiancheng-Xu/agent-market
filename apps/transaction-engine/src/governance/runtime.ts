import postgres, { type Sql } from "postgres";
import { GovernanceError, GovernanceService, type Database } from "./service";

export function database(sql: Sql): Database {
  return {
    query: async (query, values=[]) => Array.from(await sql.unsafe(query, values as never[])),
    transaction: fn => sql.begin(tx=>fn(database(tx as unknown as Sql))) as Promise<Awaited<ReturnType<typeof fn>>>,
  };
}
let service: GovernanceService | undefined;
export function getGovernanceService() {
  if (!service) {
    const url=process.env.DATABASE_URL?.trim();
    if (!url) throw new GovernanceError("GOVERNANCE_STORE_UNAVAILABLE",503);
    service=new GovernanceService(database(postgres(url,{max:5,prepare:false})));
  }
  return service;
}
