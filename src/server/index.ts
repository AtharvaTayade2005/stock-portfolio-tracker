import http from 'node:http';
import { URL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { INITIAL_NEWS_FEED, SYMBOL_CATALOG, SYMBOL_MAP } from '../shared/catalog.js';
import type {
  AlertDirection,
  OrderRequest,
  ReplaySpeed,
  WsServerMessage,
} from '../shared/types.js';
import { createDatabase } from './db.js';
import { LedgerService } from './ledgerService.js';
import { AlertEngine } from './alertEngine.js';
import { MarketEngine } from './marketEngine.js';
import { AiCopilotService } from './aiCopilot.js';

const PORT = Number(process.env.PORT || 4000);

const db = createDatabase();
const ledgerService = new LedgerService(db);
const alertEngine = new AlertEngine(db);
const marketEngine = new MarketEngine(process.env.FINNHUB_API_KEY);
const aiCopilot = new AiCopilotService(process.env.GEMINI_API_KEY);

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key',
  });
  res.end(body);
}

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(raw ? (JSON.parse(raw) as T) : ({} as T));
      } catch (err) {
        reject(new Error('Malformed JSON request body.'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (!req.url || !req.method) {
    sendJson(res, 400, { error: 'Invalid HTTP request' });
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key',
    });
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  try {
    if (req.method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, {
        status: 'ok',
        feedMode: marketEngine.getFeedMode(),
        replaySpeed: marketEngine.getReplaySpeed(),
        connectedClients: wss.clients.size,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/catalog') {
      sendJson(res, 200, {
        symbols: SYMBOL_CATALOG,
        ticks: marketEngine.getAllLatestTicks(),
        replaySpeed: marketEngine.getReplaySpeed(),
        feedMode: marketEngine.getFeedMode(),
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/candles') {
      const symbol = parsedUrl.searchParams.get('symbol') || 'RELIANCE';
      if (!SYMBOL_MAP.has(symbol)) {
        sendJson(res, 404, { error: `Symbol ${symbol} not found` });
        return;
      }
      sendJson(res, 200, {
        symbol,
        candles: marketEngine.getCandles(symbol),
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/portfolio') {
      const snapshot = ledgerService.getPortfolioSnapshot(marketEngine.getLatestTicksMap());
      sendJson(res, 200, snapshot);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/orders') {
      const body = await readJsonBody<OrderRequest>(req);
      const tick = marketEngine.getLatestTicksMap().get(body.symbol);
      if (!tick) {
        sendJson(res, 400, { error: `No live quote available for symbol ${body.symbol}` });
        return;
      }

      const executionPrice = body.side === 'BUY' ? tick.ask : tick.bid;
      const result = ledgerService.executeOrder(body, executionPrice);
      const snapshot = ledgerService.getPortfolioSnapshot(marketEngine.getLatestTicksMap());

      sendJson(res, 200, {
        order: result.order,
        deduplicated: result.deduplicated,
        portfolio: snapshot,
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/alerts') {
      sendJson(res, 200, { alerts: alertEngine.listAlerts() });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/alerts') {
      const body = await readJsonBody<{
        symbol: string;
        direction: AlertDirection;
        targetPrice: number;
        note?: string;
      }>(req);
      const created = alertEngine.createAlert(body);
      sendJson(res, 201, { alert: created, alerts: alertEngine.listAlerts() });
      return;
    }

    if (req.method === 'DELETE' && pathname.startsWith('/api/alerts/')) {
      const id = Number(pathname.replace('/api/alerts/', ''));
      alertEngine.deleteAlert(id);
      sendJson(res, 200, { alerts: alertEngine.listAlerts() });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/news') {
      sendJson(res, 200, { news: INITIAL_NEWS_FEED });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/copilot/analyze') {
      const body = await readJsonBody<{ question?: string }>(req);
      const snapshot = ledgerService.getPortfolioSnapshot(marketEngine.getLatestTicksMap());
      const analysis = await aiCopilot.analyzePortfolio(snapshot, INITIAL_NEWS_FEED, body.question);
      sendJson(res, 200, analysis);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/replay/speed') {
      const body = await readJsonBody<{ speed: ReplaySpeed }>(req);
      const validSpeeds: ReplaySpeed[] = [0, 1, 5, 10];
      if (!validSpeeds.includes(body.speed)) {
        sendJson(res, 400, { error: 'Replay speed must be 0, 1, 5, or 10.' });
        return;
      }
      const speed = marketEngine.setReplaySpeed(body.speed);
      broadcastWs({ type: 'REPLAY_SPEED_CHANGED', replaySpeed: speed });
      sendJson(res, 200, { replaySpeed: speed });
      return;
    }

    sendJson(res, 404, { error: `Route ${req.method} ${pathname} not found` });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    sendJson(res, 400, { error: message });
  }
});

const wss = new WebSocketServer({ server, path: '/ws' });

function broadcastWs(msg: WsServerMessage): void {
  const serialized = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(serialized);
    }
  }
}

wss.on('connection', (socket) => {
  const initialMsg: WsServerMessage = {
    type: 'INITIAL_STATE',
    ticks: marketEngine.getAllLatestTicks(),
    replaySpeed: marketEngine.getReplaySpeed(),
    feedMode: marketEngine.getFeedMode(),
  };
  socket.send(JSON.stringify(initialMsg));
});

marketEngine.onTickBatch((ticks, updatedCandles) => {
  broadcastWs({
    type: 'TICK_BATCH',
    ticks,
    updatedCandles,
  });

  for (const tick of ticks) {
    const triggeredAlerts = alertEngine.evaluateTick(tick);
    for (const alert of triggeredAlerts) {
      broadcastWs({
        type: 'ALERT_TRIGGERED',
        alert,
        tick,
      });
    }
  }
});

marketEngine.start();

server.listen(PORT, () => {
  console.log(`[KINETIC SERVER] HTTP & WebSocket Fan-Out listening on http://localhost:${PORT}`);
});
