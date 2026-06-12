import express from "express";
import cors from "cors";
import { catalogRouter } from "./routes/catalog.js";
import { quoteRouter } from "./routes/quote.js";
import { orderRouter } from "./routes/order.js";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));
app.use("/api/catalog", catalogRouter);
app.use("/api/quote", quoteRouter);
app.use("/api/order", orderRouter);

const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => {
  console.log(`[server] listening on :${port}`);
  console.log(`[server] catalog/quote endpoints work with no keys (public APIs)`);
  if (!process.env.OPERATOR_KEY) {
    console.log(`[server] execution pipeline DISABLED (no OPERATOR_KEY) — demo mode`);
  }
});
