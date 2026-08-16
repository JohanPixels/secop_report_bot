#!/usr/bin/env node
/**
 * Weekly SECOP II report — Cauca procurement watch
 *
 * Fetches new procurement processes from the last 7 days, aggregates them
 * with real irregularity indicators, asks Claude for a short executive
 * summary, and sends a nicely formatted report to Telegram.
 *
 * Place this at: scripts/secop-report.mjs
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY
 *   TELEGRAM_BOT_TOKEN
 *   TELEGRAM_CHAT_ID
 * Optional:
 *   SECOP_APP_TOKEN   (datos.gov.co App Token — avoids rate limiting)
 */

const SECOP_RESOURCE = "p6dx-8zbt"; // SECOP II - Procesos de Contratación
const SECOP_BASE = `https://www.datos.gov.co/resource/${SECOP_RESOURCE}.json`;

// Confirmed against real API responses on 2026-08-16, filtered to Cauca.
const FIELD_DEPARTAMENTO = "departamento_entidad";
const FIELD_FECHA = "fecha_de_publicacion_del";
const FIELD_VALOR = "precio_base";
const FIELD_ENTIDAD = "entidad";
const FIELD_NOMBRE = "nombre_del_procedimiento";
const FIELD_DESCRIPCION = "descripci_n_del_procedimiento"; // usually more informative than nombre
const FIELD_URL = "urlproceso"; // nested object: { url: "..." }
const FIELD_MODALIDAD = "modalidad_de_contratacion";
const FIELD_PROVEEDORES_UNICOS = "proveedores_unicos_con";
const FIELD_ADJUDICADO = "adjudicado"; // "Si" / "No"
const FIELD_VALOR_ADJUDICADO = "valor_total_adjudicacion";
const FIELD_FASE = "fase";
const FIELD_ESTADO = "estado_del_procedimiento";

const HIGH_VALUE_THRESHOLD_COP = 500_000_000;

function sevenDaysAgoISO() {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString().split("T")[0];
}

async function fetchSecopData() {
  const since = sevenDaysAgoISO();
  const where = `${FIELD_DEPARTAMENTO}='Cauca' AND ${FIELD_FECHA} > '${since}'`;
  const params = new URLSearchParams({
    $where: where,
    $order: `${FIELD_VALOR} DESC`,
    $limit: "100",
  });

  const headers = {};
  if (process.env.SECOP_APP_TOKEN) {
    headers["X-App-Token"] = process.env.SECOP_APP_TOKEN;
  }

  const res = await fetch(`${SECOP_BASE}?${params}`, { headers });
  if (!res.ok) {
    throw new Error(`SECOP API error: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// A process's bidder count only means something once it's stopped
// accepting new offers — this is a heuristic based on the "fase" field,
// not a guarantee. Tune it if your own Filtr research finds better signals.
function isOpenForBidding(r) {
  return r.fase.toLowerCase().includes("presentación de oferta");
}

function isCancelado(r) {
  return r.estado.toLowerCase().includes("cancel");
}

function fmtCOP(n) {
  return `$${Math.round(n / 1_000_000).toLocaleString("es-CO")}M`;
}

function aggregate(rows) {
  const parsed = rows.map((r) => {
    const descripcion = r[FIELD_DESCRIPCION] || r[FIELD_NOMBRE] || "";
    return {
      entidad: r[FIELD_ENTIDAD] ?? "Sin nombre",
      nombre: descripcion.slice(0, 90),
      valor: Number(r[FIELD_VALOR]) || 0,
      url: r[FIELD_URL]?.url ?? "",
      modalidad: r[FIELD_MODALIDAD] ?? "No definida",
      proveedoresUnicos: Number(r[FIELD_PROVEEDORES_UNICOS]) || 0,
      adjudicado: (r[FIELD_ADJUDICADO] ?? "").toLowerCase().startsWith("s"),
      valorAdjudicado: Number(r[FIELD_VALOR_ADJUDICADO]) || 0,
      fase: r[FIELD_FASE] ?? "",
      estado: r[FIELD_ESTADO] ?? "",
    };
  });

  const totalContratos = parsed.length;
  const valorTotal = parsed.reduce((sum, r) => sum + r.valor, 0);
  const top5 = [...parsed].sort((a, b) => b.valor - a.valor).slice(0, 5);
  const flagged = parsed.filter((r) => r.valor > HIGH_VALUE_THRESHOLD_COP);

  const directas = parsed.filter((r) => r.modalidad.toLowerCase().includes("directa"));
  const pctDirecta = totalContratos ? Math.round((directas.length / totalContratos) * 100) : 0;

  // Only judge competition on processes that are actually closed —
  // an open process with 0 bidders so far just hasn't finished yet.
  const bajaCompetencia = parsed.filter(
    (r) =>
      !r.modalidad.toLowerCase().includes("directa") &&
      !isOpenForBidding(r) &&
      !isCancelado(r) &&
      r.proveedoresUnicos <= 1
  );

  const sinNegociacion = parsed.filter(
    (r) => r.adjudicado && r.valorAdjudicado > 0 && r.valorAdjudicado === r.valor
  );

  const cancelados = parsed.filter(isCancelado).sort((a, b) => b.valor - a.valor);

  return {
    totalContratos,
    valorTotal,
    top5,
    flagged,
    pctDirecta,
    directasCount: directas.length,
    bajaCompetencia,
    sinNegociacion,
    cancelados,
  };
}

async function generateSummary(stats) {
  const prompt = `Eres un analista de contratación pública. Con estos datos de SECOP II para Cauca de la última semana, escribe un resumen ejecutivo de 3-4 líneas en español, directo y sin relleno. Prioriza señales de riesgo (baja competencia, contratación directa, falta de negociación, cancelaciones de alto valor) sobre solo reportar totales. Menciona entidades específicas si hay algo puntual que valga la pena revisar.

Datos:
- Total de procesos publicados: ${stats.totalContratos}
- Valor total: ${fmtCOP(stats.valorTotal)} COP
- % contratación directa: ${stats.pctDirecta}% (${stats.directasCount} procesos)
- Procesos cerrados con 0-1 oferentes reales: ${stats.bajaCompetencia.length}
- Adjudicaciones sin variación respecto al presupuesto: ${stats.sinNegociacion.length}
- Procesos cancelados: ${stats.cancelados.length}${
    stats.cancelados[0] ? ` (el mayor: ${stats.cancelados[0].entidad}, ${fmtCOP(stats.cancelados[0].valor)})` : ""
  }
- Top 5 por valor: ${stats.top5.map((c) => `${c.entidad} — ${fmtCOP(c.valor)}`).join("; ")}`;

  const res = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            {
              text: prompt,
            },
          ],
        },
      ],
      generationConfig: {
        maxOutputTokens: 300,
      },
    }),
  }
);

if (!res.ok) {
  throw new Error(`Gemini API error: ${res.status} ${await res.text()}`);
}

const data = await res.json();

return (
  data.candidates?.[0]?.content?.parts?.[0]?.text ??
  "(sin resumen)"
);
}

function formatMessage(stats, summary) {
  const divider = "━━━━━━━━━━━━━━━━━━━";

  const lines = [
    "📋 *Reporte semanal SECOP II — Cauca*",
    "",
    summary,
    "",
    divider,
    "📊 *Resumen*",
    `Total procesos: ${stats.totalContratos}`,
    `Valor total: ${fmtCOP(stats.valorTotal)} COP`,
    `Contratación directa: ${stats.pctDirecta}% (${stats.directasCount})`,
  ];

  if (stats.bajaCompetencia.length || stats.sinNegociacion.length || stats.cancelados.length) {
    lines.push("", divider, "⚠️ *Señales a revisar*");
    if (stats.bajaCompetencia.length) {
      lines.push(`• Baja competencia (0-1 oferentes, cerrados): ${stats.bajaCompetencia.length}`);
    }
    if (stats.sinNegociacion.length) {
      lines.push(`• Adjudicados sin negociación: ${stats.sinNegociacion.length}`);
    }
    if (stats.cancelados.length) {
      const top = stats.cancelados[0];
      lines.push(`• Cancelados: ${stats.cancelados.length} (mayor: ${top.entidad} — ${fmtCOP(top.valor)})`);
    }
  }

  lines.push(
    "",
    divider,
    "🏆 *Top 5 por valor*",
    ...stats.top5.map(
      (c, i) => `${i + 1}. ${c.entidad} — ${fmtCOP(c.valor)}${c.url ? `\n${c.url}` : ""}`
    )
  );

  return lines.join("\n");
}

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: "Markdown",
    }),
  });
  if (!res.ok) {
    throw new Error(`Telegram API error: ${res.status} ${await res.text()}`);
  }
}

async function main() {
  console.log("Fetching SECOP II data...");
  const rows = await fetchSecopData();
  console.log(`Got ${rows.length} rows.`);

  const stats = aggregate(rows);

  console.log("Generating executive summary...");
  const summary = await generateSummary(stats);

  const message = formatMessage(stats, summary);

  console.log("Sending to Telegram...");
  await sendTelegram(message);

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
