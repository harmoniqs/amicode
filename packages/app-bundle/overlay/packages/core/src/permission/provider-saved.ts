export * as ProviderPermissionSaved from "./provider-saved"

import { and, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { ProjectV2 } from "../project"
import { ProviderPermissionTable } from "./sql"
import { PermissionSaved } from "@opencode-ai/schema/permission-saved"

export const ID = PermissionSaved.ID
export type ID = typeof ID.Type

export const Info = Schema.Struct({
  id: ID,
  projectID: ProjectV2.ID,
  tierID: Schema.String,
  action: Schema.String,
  resource: Schema.String,
}).annotate({ identifier: "ProviderPermissionSaved.Info" })
export type Info = typeof Info.Type

export const ListInput = Schema.Struct({
  projectID: ProjectV2.ID.pipe(Schema.optional),
  tierID: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "ProviderPermissionSaved.ListInput" })
export type ListInput = typeof ListInput.Type

export const AddInput = Schema.Struct({
  projectID: ProjectV2.ID,
  tierID: Schema.String,
  action: Schema.String,
  resources: Schema.Array(Schema.String),
}).annotate({ identifier: "ProviderPermissionSaved.AddInput" })
export type AddInput = typeof AddInput.Type

export interface Interface {
  readonly list: (input?: ListInput) => Effect.Effect<ReadonlyArray<Info>>
  readonly add: (input: AddInput) => Effect.Effect<void>
  readonly remove: (id: ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ProviderPermissionSaved") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const list = Effect.fn("ProviderPermissionSaved.list")(function* (input?: ListInput) {
      const conditions = [
        input?.projectID ? eq(ProviderPermissionTable.project_id, input.projectID) : undefined,
        input?.tierID ? eq(ProviderPermissionTable.tier_id, input.tierID) : undefined,
      ].filter(Boolean) as never[]
      const where = conditions.length ? and(...conditions) : undefined
      const rows = yield* db.select().from(ProviderPermissionTable).where(where).all().pipe(Effect.orDie)
      return rows.map(
        (row): Info => ({
          id: row.id as ID,
          projectID: row.project_id as ProjectV2.ID,
          tierID: row.tier_id,
          action: row.action,
          resource: row.resource,
        }),
      )
    })

    const add = Effect.fn("ProviderPermissionSaved.add")(function* (input: AddInput) {
      if (!input.resources.length) return
      yield* db
        .insert(ProviderPermissionTable)
        .values(
          input.resources.map((resource) => ({
            id: ID.create(),
            project_id: input.projectID,
            tier_id: input.tierID,
            action: input.action,
            resource,
          })),
        )
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
    })

    const remove = Effect.fn("ProviderPermissionSaved.remove")(function* (id: ID) {
      yield* db.delete(ProviderPermissionTable).where(eq(ProviderPermissionTable.id, id)).run().pipe(Effect.orDie)
    })

    return Service.of({ list, add, remove })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
