import lbug, { type LbugValue } from "@ladybugdb/core";
import { settings } from "@/settings";

type Connection = InstanceType<typeof lbug.Connection>;

export class GraphMemory {
  private static instance: GraphMemory | null = null;
  private connectionPromise: Promise<Connection>;

  constructor() {
    this.connectionPromise = (async () => {
      const db = new lbug.Database(settings.GRAPH_DB_PATH);
      const connection = new lbug.Connection(db);
      await this.initSchema(connection);
      return connection;
    })();
  }

  /**
   * Returns the singleton graph memory instance.
   *
   * @returns The shared `GraphMemory` instance.
   */
  static getInstance(): GraphMemory {
    if (!GraphMemory.instance) {
      GraphMemory.instance = new GraphMemory();
    }
    return GraphMemory.instance;
  }

  /**
   * Initializes the graph schema if it does not already exist.
   *
   * @param connection The database connection to initialize.
   */
  private async initSchema(connection: Connection): Promise<void> {
    const statements = [
      `CREATE NODE TABLE Entity(name STRING, type STRING, notes STRING, PRIMARY KEY(name))`,
      `CREATE REL TABLE RELATES_TO(FROM Entity TO Entity, relation STRING)`,
    ];
    for (const statement of statements) {
      try {
        await connection.query(statement);
      } catch (err) {
        if (!(err as Error).message.includes("already exists")) {
          throw err;
        }
      }
    }
  }

  /**
   * Executes a parameterized Cypher query.
   *
   * @param cypher The Cypher query to execute.
   * @param params The values to bind to query parameters.
   * @returns The rows returned by the query.
   */
  async run(
    cypher: string,
    params: Record<string, LbugValue>,
  ): Promise<Record<string, LbugValue>[]> {
    const connection = await this.connectionPromise;
    const statement = await connection.prepare(cypher);
    const result = await connection.execute(statement, params);
    const singleResult = Array.isArray(result) ? result[0] : result;
    return singleResult.getAll();
  }

  /**
   * Creates or updates an entity in the graph.
   *
   * @param name The unique name of the entity.
   * @param type The type of the entity.
   * @param notes Notes describing the entity.
   */
  async upsertEntity(name: string, type: string, notes: string): Promise<void> {
    await this.run(
      `MERGE (e:Entity {name: $name})
      ON CREATE SET e.type = $type, e.notes = $notes
      ON MATCH SET e.notes = $notes`,
      { name, type, notes },
    );
  }

  /**
   * Creates a relationship between two existing entities.
   *
   * @param fromName The name of the source entity.
   * @param relation The relationship type or label.
   * @param toName The name of the target entity.
   */
  async upsertRelation(
    fromName: string,
    relation: string,
    toName: string,
  ): Promise<void> {
    await this.run(
      `MATCH (a:Entity {name: $fromName}), (b:Entity {name: $toName})
      MERGE (a)-[r:RELATES_TO {relation: $relation}]->(b)`,
      { fromName, relation, toName },
    );
  }

  /**
   * Retrieves an entity and its incoming and outgoing relationships.
   *
   * @param name The exact name of the entity to recall.
   * @returns A formatted memory string, or `null` if the entity does not exist.
   */
  async recall(name: string): Promise<string | null> {
    const entityRows = await this.run(
      `MATCH (e:Entity {name: $name}) RETURN e.type AS type, e.notes AS notes`,
      { name },
    );
    if (entityRows.length === 0) return null;

    const outgoing = await this.run(
      `MATCH (e:Entity {name: $name})-[r:RELATES_TO]->(other)
     RETURN r.relation AS relation, other.name AS name`,
      { name },
    );
    const incoming = await this.run(
      `MATCH (other)-[r:RELATES_TO]->(e:Entity {name: $name})
     RETURN r.relation AS relation, other.name AS name`,
      { name },
    );

    const { type, notes } = entityRows[0];
    const lines = [`${name} (${type}): ${notes || "(no notes)"}`];
    for (const row of outgoing) {
      lines.push(`- ${name} ${row.relation} ${row.name}`);
    }
    for (const row of incoming) {
      lines.push(`- ${row.name} ${row.relation} ${name}`);
    }
    return lines.join("\n");
  }

  /**
   * Builds an index of all entities stored in graph memory.
   *
   * @returns A formatted entity index, or an empty string when no entities exist.
   */
  async getMemoryIndex(): Promise<string> {
    const rows = await this.run(
      `MATCH (e:Entity) RETURN e.name AS name, e.type AS type ORDER BY e.type, e.name`,
      {},
    );
    if (rows.length === 0) return "";

    const lines = rows.map((r) => `- ${r.name} (${r.type})`);
    return [
      "You have long-term memory about the following entities. Call",
      "recall_memory with an exact name from this list to load full",
      "details and connections for that entity before answering",
      "questions about it.",
      "",
      ...lines,
    ].join("\n");
  }

  /**
   * Stores a conversation summary and links it to related entities.
   *
   * @param summary The summary of the conversation.
   * @param entityNames The names of entities associated with the conversation.
   */
  async recordConversation(
    summary: string,
    entityNames: string[],
  ): Promise<void> {
    const conversationName = `conversation-${Date.now()}`;
    await this.upsertEntity(conversationName, "conversation", summary);
    for (const entityName of entityNames) {
      const existing = await this.run(
        `MATCH (e:Entity {name: $name}) RETURN e.name AS name`,
        { name: entityName },
      );
      if (existing.length === 0) {
        await this.upsertEntity(entityName, "topic", "");
      }
      await this.upsertRelation(conversationName, "about", entityName);
    }
  }

  /**
   * Closes the graph database connection.
   */
  async closeGraph(): Promise<void> {
    if (this.connectionPromise) {
      const connection = await this.connectionPromise;
      await connection.close();
    }
  }
}
