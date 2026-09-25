import { createSchema } from "graphql-yoga";
import { resolvers } from "./resolvers";

const typeDefs = /* GraphQL */ `
  type Vault {
    id: ID!
    walletAddress: String!
    tvl: Float!
    totalYield: Float!
    updatedAt: String!
    transactions(limit: Int = 20): [Transaction!]!
    yieldSnapshots(limit: Int = 30): [YieldSnapshot!]!
  }

  type User {
    id: ID!
    walletAddress: String!
    notifications(limit: Int = 20): [Notification!]!
    vault: Vault
    transactions(limit: Int = 20): [Transaction!]!
  }

  type Transaction {
    id: ID!
    walletAddress: String!
    provider: String!
    status: String!
    amountFiat: Float!
    currency: String!
    amountUsdc: Float!
    providerTxId: String!
    createdAt: String!
    updatedAt: String!
  }

  type YieldSnapshot {
    id: ID!
    protocolName: String!
    apy: Float!
    tvl: Float!
    riskScore: Float!
    source: String!
    fetchedAt: String!
    snapshotAt: String!
  }

  type Notification {
    id: ID!
    walletAddress: String!
    type: String!
    title: String!
    message: String!
    isRead: Boolean!
    createdAt: String!
  }

  type Query {
    vault(id: ID!): Vault
    vaults(limit: Int = 50): [Vault!]!
    user(walletAddress: String!): User
    users(limit: Int = 50): [User!]!
    transactions(walletAddress: String, limit: Int = 50): [Transaction!]!
    yieldSnapshots(protocolName: String, limit: Int = 50): [YieldSnapshot!]!
  }
`;

export const graphqlSchema = createSchema({
  typeDefs,
  resolvers,
});
