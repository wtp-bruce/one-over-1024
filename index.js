import express from "express";

// Vercel Express detection requires this entry file to import express.
// The HTTP server (Express + Socket.IO) lives in server/index.js.
export { default } from "./server/index.js";

void express;
