/**
 * OpenCode tool definition helpers.
 *
 * OpenCode V2 registers tools through `ctx.tool.transform` with JSON Schema
 * input definitions. These helpers keep the existing tool modules declarative
 * (`tool.schema.string()...`) without pulling in a schema library that the
 * OpenCode runtime does not resolve for project plugins.
 */

export type JsonSchema = Record<string, unknown>

export interface ToolRuntimeContext {
  directory?: string
  worktree?: string
  signal?: AbortSignal
  [key: string]: unknown
}

export interface ToolDefinition {
  name?: string
  description: string
  input: JsonSchema
  execute: (args: Record<string, unknown>, context: ToolRuntimeContext) => Promise<string> | string
}

class Field {
  constructor(private readonly schema: JsonSchema = {}) {}

  string(): Field {
    return new Field({ ...this.schema, type: "string" })
  }

  number(): Field {
    return new Field({ ...this.schema, type: "number" })
  }

  boolean(): Field {
    return new Field({ ...this.schema, type: "boolean" })
  }

  enum(values: readonly unknown[]): Field {
    return new Field({ ...this.schema, enum: [...values] })
  }

  optional(): Field {
    return new Field({ ...this.schema, __optional: true })
  }

  describe(description: string): Field {
    return new Field({ ...this.schema, description })
  }

  isOptional(): boolean {
    return this.schema.__optional === true
  }

  toJSON(): JsonSchema {
    const { __optional: _optional, ...rest } = this.schema
    return rest
  }
}

interface ToolOptions {
  description: string
  args: Record<string, Field>
  execute: ToolDefinition["execute"]
}

export const tool = Object.assign(
  (options: ToolOptions): ToolDefinition => {
    const properties: Record<string, JsonSchema> = {}
    const required: string[] = []

    for (const [name, field] of Object.entries(options.args)) {
      properties[name] = field.toJSON()
      if (!field.isOptional()) required.push(name)
    }

    return {
      description: options.description,
      input: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
      execute: options.execute,
    }
  },
  {
    schema: {
      string: () => new Field(),
      number: () => new Field(),
      boolean: () => new Field(),
      enum: (values: readonly unknown[]) => new Field({ enum: [...values] }),
    },
  }
)
