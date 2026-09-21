#!/usr/bin/env node

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function numberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} deve ser um numero; recebido: ${raw}`);
  }
  return value;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick(values) {
  return values[randomInt(0, values.length - 1)];
}

function randomDurationMs() {
  const percentile = Math.random();
  if (percentile < 0.8) return randomInt(25, 800);
  if (percentile < 0.97) return randomInt(801, 3000);
  return randomInt(3001, 8000);
}

function randomRemoteAddress() {
  return `10.${randomInt(0, 20)}.${randomInt(0, 255)}.${randomInt(1, 254)}`;
}

const endpoints = [
  {
    httpMethod: "POST",
    servicePath: "/commons/documentos",
    operation: "http://novvs.enova.com.br//ListInWidget",
    service: "Documentos",
  },
  {
    httpMethod: "POST",
    servicePath: "/novvs/documentotipos",
    operation: "http://novvs.enova.com.br//ListDocumentoTipos",
    service: "DocumentoTipos",
  },
  {
    httpMethod: "POST",
    servicePath: "/aduaneiro/processos",
    operation: "http://novvs.enova.com.br//ParametrosProcesso",
    service: "Processos",
  },
  {
    httpMethod: "POST",
    servicePath: "/aduaneiro/declaracoes",
    operation: "http://novvs.enova.com.br//ListDeclaracoes",
    service: "Declaracoes",
  },
  {
    httpMethod: "GET",
    servicePath: "/commons/usuarios",
    operation: "http://novvs.enova.com.br//GetUsuario",
    service: "Usuarios",
  },
  {
    httpMethod: "POST",
    servicePath: "/financeiro/faturas",
    operation: "http://novvs.enova.com.br//ListFaturas",
    service: "Faturas",
  },
];

const failureStatuses = [400, 400, 404, 409, 422, 500, 500, 502, 503];
const logFile = process.env.NOVVS_LOG_FILE || "/opt/novvs/logs/requests.jsonl";
const minRps = Math.trunc(numberFromEnv("MIN_RPS", 5));
const maxRps = Math.trunc(numberFromEnv("MAX_RPS", 10));
const errorRate = numberFromEnv("ERROR_RATE", 0.05);
const abandonRate = numberFromEnv("ABANDON_RATE", 0);
const durationSeconds = numberFromEnv("DURATION_SECONDS", 0);

if (minRps < 1 || maxRps < minRps) {
  throw new Error("MIN_RPS deve ser >= 1 e MAX_RPS deve ser >= MIN_RPS");
}
if (errorRate < 0 || errorRate > 1 || abandonRate < 0 || abandonRate > 1) {
  throw new Error("ERROR_RATE e ABANDON_RATE devem estar entre 0 e 1");
}
if (durationSeconds < 0) {
  throw new Error("DURATION_SECONDS deve ser >= 0");
}

fs.mkdirSync(path.dirname(logFile), { recursive: true });
const output = fs.createWriteStream(logFile, { flags: "a", encoding: "utf8" });

let acceptingRequests = true;
let inFlight = 0;
let requestCount = 0;
let eventCount = 0;
let errorCount = 0;
let abandonedCount = 0;
const scheduledStarts = new Set();

output.on("error", (error) => {
  console.error(`Erro ao escrever em ${logFile}: ${error.message}`);
  process.exitCode = 1;
  shutdown();
});

function append(event) {
  output.write(`${JSON.stringify(event)}\n`);
  eventCount += 1;
}

function generateRequest() {
  if (!acceptingRequests) return;

  const endpoint = pick(endpoints);
  const requestId = crypto.randomUUID();
  const claimedUserId = String(randomInt(1, 50));
  const remoteAddr = randomRemoteAddress();
  const startedAt = Date.now();

  requestCount += 1;
  inFlight += 1;

  append({
    timestamp: startedAt,
    eventType: "REQUEST_START",
    requestId,
    httpMethod: endpoint.httpMethod,
    servicePath: endpoint.servicePath,
    operation: endpoint.operation,
    remoteAddr,
    claimedUserId,
  });

  if (Math.random() < abandonRate) {
    abandonedCount += 1;
    inFlight -= 1;
    finishIfStopped();
    return;
  }

  const durationMs = randomDurationMs();
  const failed = Math.random() < errorRate;

  setTimeout(() => {
    const httpStatus = failed ? pick(failureStatuses) : 200;
    if (failed) errorCount += 1;

    append({
      timestamp: startedAt + durationMs,
      eventType: "REQUEST_END",
      requestId,
      httpMethod: endpoint.httpMethod,
      servicePath: endpoint.servicePath,
      operation: endpoint.operation,
      remoteAddr,
      claimedUserId,
      service: endpoint.service,
      httpStatus,
      status: failed ? "ERROR" : "SUCCESS",
      durationMs,
    });

    inFlight -= 1;
    finishIfStopped();
  }, durationMs);
}

function scheduleSecond() {
  if (!acceptingRequests) return;

  const requestsThisSecond = randomInt(minRps, maxRps);
  for (let index = 0; index < requestsThisSecond; index += 1) {
    const delayMs = Math.floor(((index + Math.random()) * 1000) / requestsThisSecond);
    const timer = setTimeout(() => {
      scheduledStarts.delete(timer);
      generateRequest();
    }, delayMs);
    scheduledStarts.add(timer);
  }
}

function finishIfStopped() {
  if (acceptingRequests || inFlight > 0) return;

  clearInterval(reportTimer);
  output.end(() => {
    console.log(
      `Finalizado: ${requestCount} requests, ${eventCount} eventos, ` +
        `${errorCount} erros e ${abandonedCount} sem REQUEST_END.`,
    );
  });
}

function shutdown() {
  if (!acceptingRequests) return;
  acceptingRequests = false;
  clearInterval(secondTimer);
  clearTimeout(durationTimer);

  for (const timer of scheduledStarts) clearTimeout(timer);
  scheduledStarts.clear();

  console.log(`Encerrando; aguardando ${inFlight} requests em andamento...`);
  finishIfStopped();
}

console.log(`Gravando em: ${logFile}`);
console.log(
  `Carga: ${minRps}-${maxRps} req/s; erros: ${(errorRate * 100).toFixed(1)}%; ` +
    `sem REQUEST_END: ${(abandonRate * 100).toFixed(1)}%`,
);
console.log(durationSeconds > 0 ? `Duracao: ${durationSeconds}s` : "Duracao: ate Ctrl+C");

scheduleSecond();
const secondTimer = setInterval(scheduleSecond, 1000);
const reportTimer = setInterval(() => {
  console.log(
    `requests=${requestCount} eventos=${eventCount} em_andamento=${inFlight} ` +
      `erros=${errorCount} sem_fim=${abandonedCount}`,
  );
}, 5000);
const durationTimer =
  durationSeconds > 0 ? setTimeout(shutdown, durationSeconds * 1000) : undefined;

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
