#!/usr/bin/env node
/**
 * Weekly SECOP II report — Cauca procurement watch
 *
 * Fetches new procurement processes from the last 7 days, aggregates them
 * with deterministic indicators, asks Gemini for a short executive
 * interpretation, and sends a formatted report to Telegram.
 *
 * Required env vars:
 *   GEMINI_API_KEY
 *   TELEGRAM_BOT_TOKEN
 *   TELEGRAM_CHAT_ID
 * Optional:
 *   SECOP_APP_TOKEN
 */

const SECOP_RESOURCE = "p6dx-8zbt";
const SECOP_BASE = `https://www.datos.gov.co/resource/${SECOP_RESOURCE}.json`;

// Confirmed against real API responses on 2026-08-16, filtered to Cauca.
const FIELD_DEPARTAMENTO = "departamento_entidad";
const FIELD_FECHA = "fecha_de_publicacion_del";
const FIELD_VALOR = "precio_base";
const FIELD_ENTIDAD = "entidad";
const FIELD_NOMBRE = "nombre_del_procedimiento";
const FIELD_DESCRIPCION = "descripci_n_del_procedimiento";
const FIELD_URL = "urlproceso";
const FIELD_MODALIDAD = "modalidad_de_contratacion";
const FIELD_PROVEEDORES_UNICOS = "proveedores_unicos_con";
const FIELD_ADJUDICADO = "adjudicado";
const FIELD_VALOR_ADJUDICADO = "valor_total_adjudicacion";
const FIELD_FASE = "fase";
const FIELD_ESTADO = "estado_del_procedimiento";

const HIGH_VALUE_THRESHOLD_COP = 500_000_000;

const MODEL = "gemini-3.5-flash-lite";

function sevenDaysAgoISO() {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString().split("T")[0];
}

function formatDate(date = new Date()) {
  return new Intl.DateTimeFormat("es-CO", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  })
    .format(date)
    .replace(".", "");
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

// A process's bidder count only means something once it has stopped
// accepting new offers. This is a heuristic based on the "fase" field.
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

  const valorTotal = parsed.reduce(
    (sum, r) => sum + r.valor,
    0
  );

  const top5 = [...parsed]
    .sort((a, b) => b.valor - a.valor)
    .slice(0, 5);

  const flagged = parsed.filter(
    (r) => r.valor > HIGH_VALUE_THRESHOLD_COP
  );

  const directas = parsed.filter((r) =>
    r.modalidad.toLowerCase().includes("directa")
  );

  const pctDirecta = totalContratos
    ? Math.round((directas.length / totalContratos) * 100)
    : 0;

  // Only judge competition on processes that are actually closed.
  const bajaCompetencia = parsed.filter(
    (r) =>
      !r.modalidad.toLowerCase().includes("directa") &&
      !isOpenForBidding(r) &&
      !isCancelado(r) &&
      r.proveedoresUnicos <= 1
  );

  const sinNegociacion = parsed.filter(
    (r) =>
      r.adjudicado &&
      r.valorAdjudicado > 0 &&
      r.valorAdjudicado === r.valor
  );

  const cancelados = parsed
    .filter(isCancelado)
    .sort((a, b) => b.valor - a.valor);

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
  const prompt = `
Eres un analista de contratación pública especializado en detectar
señales que ameriten revisión en datos de SECOP II.

Analiza los indicadores calculados para procesos publicados en Cauca
durante la última semana y escribe un resumen ejecutivo de 3-4 líneas
en español.

OBJETIVO:
Identificar patrones relevantes y explicar por qué podrían merecer
una revisión humana.

REGLAS IMPORTANTES:
- NO inventes datos.
- NO inventes entidades, cifras o relaciones que no aparezcan en los datos.
- NO afirmes que existe corrupción, fraude, direccionamiento,
  colusión o irregularidad.
- Una señal de riesgo NO equivale a una irregularidad confirmada.
- Utiliza expresiones como "señal para revisar", "amerita revisión",
  "podría requerir análisis adicional" o similares.
- NO presentes la contratación directa como irregular por sí misma.
- NO presentes baja competencia como evidencia de corrupción.
- Prioriza patrones relevantes sobre simplemente repetir los totales.
- Si existe una entidad o proceso particularmente relevante,
  puedes mencionarlo.
- Mantén un tono objetivo, periodístico y sobrio.
- No utilices lenguaje alarmista.
- No hagas recomendaciones legales.
- El texto debe poder ser leído por una persona sin conocimientos
  técnicos.

DATOS CALCULADOS:

Total de procesos publicados:
${stats.totalContratos}

Valor total:
${fmtCOP(stats.valorTotal)} COP

Contratación directa:
${stats.pctDirecta}% (${stats.directasCount} procesos)

Procesos cerrados con 0-1 oferentes:
${stats.bajaCompetencia.length}

Adjudicaciones sin variación frente al presupuesto:
${stats.sinNegociacion.length}

Procesos cancelados:
${stats.cancelados.length}

Procesos de alto valor (> $500M):
${stats.flagged.length}

Mayor proceso cancelado:
${
  stats.cancelados[0]
    ? `${stats.cancelados[0].entidad} — ${fmtCOP(stats.cancelados[0].valor)}`
    : "Ninguno"
}

Top 5 por valor:
${stats.top5
  .map((c) => `${c.entidad} — ${fmtCOP(c.valor)}`)
  .join("; ")}
`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
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
    throw new Error(
      `Gemini API error: ${res.status} ${await res.text()}`
    );
  }

  const data = await res.json();

  return (
    data.candidates?.[0]?.content?.parts?.[0]?.text ??
    "(sin resumen)"
  );
}

function formatMessage(stats, summary) {
  const divider = "━━━━━━━━━━━━━━━━━━━━";

  const hasSignals =
    stats.bajaCompetencia.length ||
    stats.sinNegociacion.length ||
    stats.cancelados.length;

  const lines = [
    "🔎 *FILTR · WEEKLY WATCH*",
    "*SECOP II · CAUCA*",
    `_${formatDate()} · últimos 7 días_`,
    "",
    "💰 *Actividad pública*",
    `💵 ${fmtCOP(stats.valorTotal)} COP`,
    `📑 ${stats.totalContratos} procesos`,
    `🎯 ${stats.pctDirecta}% contratación directa`,
    "",
    divider,
    "",
    "🧠 *LECTURA DE LA SEMANA*",
    "",
    summary,
    "",
    divider,
    "",
    hasSignals
      ? "⚠️ *SEÑALES PARA REVISAR*"
      : "🟢 *SIN SEÑALES DESTACADAS*",
  ];

  if (hasSignals) {
    if (stats.bajaCompetencia.length) {
      lines.push(
        `🔸 Baja competencia · ${stats.bajaCompetencia.length}`
      );
    }

    if (stats.sinNegociacion.length) {
      lines.push(
        `🔸 Sin variación presupuestal · ${stats.sinNegociacion.length}`
      );
    }

    if (stats.cancelados.length) {
      const top = stats.cancelados[0];

      lines.push(
        `🔸 Cancelados · ${stats.cancelados.length}`
      );

      lines.push(
        `   Mayor: ${top.entidad} · ${fmtCOP(top.valor)}`
      );
    }
  }

  lines.push(
    "",
    divider,
    "",
    "🏆 *MAYORES PROCESOS*",
    ""
  );

  stats.top5.forEach((c, i) => {
    const entity = c.entidad.trim();

    lines.push(
      `*${String(i + 1).padStart(2, "0")} · ${entity}*`,
      `💰 ${fmtCOP(c.valor)}`
    );

    if (c.url) {
      lines.push(`🔎 [Ver proceso en SECOP II](${c.url})`);
    }

    lines.push("");
  });

  lines.push(
    divider,
    "",
    "_Las señales identificadas son indicadores de revisión y no constituyen por sí mismas evidencia de irregularidades._"
  );

  return lines.join("\n");
}

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    }),
  });

  if (!res.ok) {
    throw new Error(
      `Telegram API error: ${res.status} ${await res.text()}`
    );
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
