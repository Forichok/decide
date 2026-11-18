// protocol.mjs — the version of the conversation between a decide client and
// the home's server. A server speaks its own protocol and the one before it, so
// a client one step behind keeps working while the server is upgraded.

export const PROTOCOL = 3;

export const speaks = (server, client) => client === server || client === server - 1;
