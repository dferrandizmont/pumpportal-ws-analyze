## Guía de uso: Analysis Output y Backtest Output

Esta guía explica paso a paso cómo generar, leer e interpretar los reportes y archivos que produce el analizador (analysis) y el backtester (backtest). Está pensada para que puedas tomar decisiones claras sobre los umbrales (ENV) que mejor capturan los tokens “good” minimizando falsos positivos.

---

### 1) Preparación rápida

- Requisitos: Node 18+ (ideal 20/22/24).
- Instalar deps (si no lo hiciste): `yarn` o `npm i`.
- Logs esperados:
    - `logs/tracking-summaries.log` (líneas con JSON de tipo "summary").
    - `tracking/<mint>-websocket.log` (opcional, para backtest Etapa 2; se generan al activar el tracking en runtime).

---

### 2) Análisis base (analysis)

El análisis “particiona” los summaries por outcome y busca reglas simples (Etapa 1) con métricas “pre-\*” y de tamaño. Además genera un reporte HTML con presets y un snippet .env listo para copiar.

#### 2.1 Generar outputs de análisis

1. Dividir summaries por outcome:

```
npm run split:summaries
```

- Salida: `logs/summary-outcomes/good.jsonl`, `bad.jsonl`, `neutral.jsonl`.

2. Ejecutar análisis de reglas (Etapa 1):

```
npm run analyze:good
```

- Salidas (carpeta `analysis-output/`):
    - `report.html`: reporte visual con tema claro/oscuro (switch), tablas ordenables y snippet `.env` para copiar/pegar.
    - `summary_stats.csv`: estadística por outcome (good/bad/neutral) para cada métrica.
    - `threshold_search.csv`: búsqueda completa de reglas (grande).
    - `threshold_top100.csv`: top 100 reglas por F1.
    - `recommended_rule.json`: regla recomendada (por F1) con sus métricas.

#### 2.2 Leer el análisis (report.html)

- Abre `analysis-output/report.html`. Incluye:
    - Resumen y tasa base (Baseline): proporción total de “good” del dataset.
    - Presets de reglas:
        - Regla recomendada (máx F1)
        - Máxima precisión
        - Máximo recall
    - Cada tarjeta de preset muestra:
        - Métricas: precision, recall, F1, coverage, lift.
        - Chips con condiciones (umbrales Etapa 1).
        - Snippet `.env` machine-friendly (decimales con punto y sin separadores) + botón “Copiar”.
    - Estadística descriptiva por outcome: tablas con count, min, p25, mediana, p75, max por métrica.

#### 2.3 Interpretar columnas clave (threshold_top100.csv)

- minBuyRatio: preBuys / (preBuys + preSells)
- minBuys / minTrades / minUnique: mínimos de actividad previa
- minNetBuys: preBuys − preSells mínimo
- minMcUsd / maxMcUsd: rango del entry MC (USD)
- minUnique/Trade: preUniqueTraders / preTotalTrades mínimo (densidad)
- minBuys/Unique: preBuys / preUniqueTraders mínimo
- minΔBuys: incremento vs métricas preEntry (si se usa; 0 = no exige)
- maxMcVolRatio: relación preEntryMaxMcUsd / preEntryMinMcUsd máxima
- maxAgeSec: antigüedad al trigger máxima (segundos)
- precision: de los seleccionados, % que son “good”
- recall: de todos los “good”, % capturado por la regla
- F1: equilibrio entre precision y recall
- coverage: % del dataset que pasa la regla (volumen)
- lift: precisión relativa a la tasa base
- positives: nº de filas que pasan la regla
- goodPred: nº de “good” dentro de los positives

Ejemplo de fila interpretada:

```
#1  0,55  5  5  5  2  1000  ∞  0  0  0  5  3600  19,51%  14,73%  16,79%  9,96%  1,48  938  183
```

- buyRatio ≥ 0.55; preBuys ≥ 5; preTotalTrades ≥ 5; preUniqueTraders ≥ 5; netBuys ≥ 2; entryMcUsd ≥ 1000; sin tope de MC (∞);
- (con columnas extra) minUnique/Trade=0, minBuys/Unique=0, minΔBuys=0, maxMcVolRatio=5, maxAgeSec=3600;
- precision 19.51%, recall 14.73%, F1 16.79%, coverage 9.96%, lift 1.48; positives 938 (de los cuales 183 son good).

#### 2.4 Snippet .env (Etapa 1)

- El HTML muestra un snippet listo para copiar. Activar filtros en runtime:

```
TRACK_FILTERS_ENABLED=true
TRACK_ALL_MINTS=false
TRACK_MIN_BUYS=...
TRACK_MIN_TOTAL_TRADES=...
TRACK_MIN_UNIQUE_TRADERS=...
TRACK_MIN_BUY_RATIO=...
TRACK_MIN_NET_BUYS=...
TRACK_MIN_MC_USD=...
TRACK_MAX_MC_USD=        # vacío = sin límite
TRACK_MIN_UNIQUE_PER_TRADE=...
TRACK_MIN_BUYS_PER_UNIQUE=...
TRACK_MAX_AGE_AT_TRIGGER_SEC=...
TRACK_MAX_MC_VOLATILITY_RATIO=...
```

- Importante: En `.env`, los decimales van con punto. El HTML ya los da en formato de máquina.
- `TRACK_ALL_MINTS=true` ignora filtros y trackea todo tras el creator sell (útil para recolectar datos).

---

### 3) Backtest offline (con confirmación Etapa 2)

El backtester evalúa estrategias más completas combinando:

- Etapa 1 (pre-\*): mismos umbrales del análisis base.
- Etapa 2 (confirmación temprana): en 30s/60s tras el trigger, exige mínimo de trades y/o un salto de maxPct temprano.

#### 3.1 Ejecutar backtest

```
npm run analyze:backtest
```

- Variables opcionales:
    - `BT_LIMIT=300` para muestrear y acelerar iteraciones.
    - `BT_OBJECTIVE=f1 | precision | recall | recall_min_precision`
    - `BT_MIN_PRECISION=0.25` (para recall_min_precision)
    - `BT_MIN_COVERAGE=0.05` (para precision con cobertura mínima)
    - `BT_WORKERS=0` (auto: CPUs−1) o un número fijo
    - `BT_TOPK=25` tamaño del Top‑K para JSON/HTML

- Salidas (carpeta `backtest-output/`):
    - `backtest_results.csv`: todas las combinaciones Stage1+Stage2.
    - `backtest_top_f1.json`, `backtest_top_precision.json`, `backtest_top_recall.json`.
    - `recommended_backtest_rule.json`: regla recomendada según `BT_OBJECTIVE`.
    - `backtest-report.html`: reporte visual con 3 tablas top y tarjeta con snippet `.env` (Etapa 1 + Etapa 2) y botón “Copiar”.

#### 3.2 Leer el backtest (backtest-report.html)

- Abre `backtest-output/backtest-report.html`. Incluye:
    - Tasa base (Baseline), recuentos por outcome (good/neutral/bad).
    - Regla recomendada (según `BT_OBJECTIVE`) con métricas + snippet `.env` de Etapa 1 y Etapa 2 (`TRACK_STAGE2_*`).
    - Tablas Top 25 por F1 / Precisión / Recall (incluye columnas de Etapa 2: `winSec`, `minTrades`, `minMaxPct`).
    - Matriz de confusión aproximada para la regla recomendada: TP, FP (desglose neutral/bad), FN.

#### 3.3 Interpretar columnas extra (Etapa 2)

- winSec: ventana (30 o 60s) tras el trigger.
- minTrades: nº mínimo de trades en la ventana.
- minMaxPct: incremento máximo (maxPct) mínimo en la ventana.
- Si no se cumple Etapa 2, la sesión no se selecciona (reduce neutrales/bad).

#### 3.4 Aplicar en runtime (opcional: Etapa 2)

- Aún no está integrada la Etapa 2 en la app (tracking), pero el backtest ya sugiere los ENV:

```
TRACK_STAGE2_ENABLED=true
TRACK_STAGE2_WINDOW_SEC=30 | 60
TRACK_STAGE2_MIN_TRADES=...
TRACK_STAGE2_MIN_MAXPCT=...
```

- Si quieres, podemos implementarla en el runtime: tras arrancar tracking, esperar 30–60s y confirmar la señal (minTrades y/o minMaxPct) antes de alertar/cerrar. Reduce falsos positivos.

#### 3.5 Paralelización (multi‑worker)

- El backtest distribuye el grid de reglas (Etapa 1 × Etapa 2) entre varios `worker_threads`.
- Mientras recibe batches de resultados de cada worker, escribe `backtest_results.csv` en streaming y mantiene solo el Top‑K por objetivo en memoria.
- Configura `BT_WORKERS` (0 = auto, CPUs−1) y `BT_TOPK` (por defecto 25). Escala casi lineal hasta saturar CPU/IO.

Notas de rendimiento:

- El dataset se carga una sola vez y se indexan las métricas tempranas por sesión para Etapa 2.
- Recomendado dejar `BT_WORKERS=0` salvo que quieras limitar manualmente.

---

### 4) Wallet backtest (simulación de cartera)

Simula una cartera secuencial sobre sesiones reales de una estrategia concreta. Procesa cada sesión en orden temporal y aplica TP/SL/Timeout con fees/slippage.

Comando:

```
npm run analyze:wallet
```

Variables (en `.env`):

- `BACKTEST_STRATEGY_ID` estrategia (id en `strategies.json`, p. ej. `f1Balanced`).
- `BACKTEST_INITIAL_SOL` saldo inicial (ej. `1.5`).
- Asignación por trade: usa una de las dos:
    - `BACKTEST_ALLOC_SOL` SOL fijos por operación, o
    - `BACKTEST_ALLOC_PCT` fracción de cartera (por defecto `1.0` = 100%).
- Reglas de salida: `BACKTEST_TP_PCT`, `BACKTEST_SL_PCT`, `BACKTEST_TIMEOUT_SEC`.
    - `BACKTEST_SL_PCT` admite valores negativos o positivos (se normaliza a absoluto).
- Costes: `BACKTEST_FEE_PCT`, `BACKTEST_SLIPPAGE_PCT` (por lado; aplica ida+vuelta).
- Rendimiento: `BACKTEST_LIMIT` (muestra) y `BACKTEST_PARSE_CONCURRENCY` (paraleliza el parseo de logs).

Entradas y orden:

- Lee ficheros `tracking/<estrategia>/*-websocket.log` (o `tracking.logDir` de la estrategia).
- Parsea sesiones en paralelo y las ordena por `startedAt` ascendente.
- Importante: sesiones sin summary se descartan (no se simulan).

Salidas:

- `backtest-output/wallet/trades.csv` (cada operación).
- `backtest-output/wallet/summary.json` (KPIs: final, winrate, max drawdown, etc.).
- `backtest-output/wallet/report.html` (resumen y enlaces a archivos).

Modelo:

- Secuencial: la cartera se actualiza tras cada operación; si no hay fondos suficientes, se detiene (bancarrota efectiva).
- Eventos de salida: TP, SL, Timeout; si no se alcanza ninguno y termina la sesión, se usa el último punto.

---

### 5) FAQ (rápido)

- ¿Qué es Baseline? Proporción de “good” global en el dataset, referencia de azar.
- ¿Qué es Precision? De lo seleccionado por la regla, % que realmente es “good”.
- ¿Qué es Recall? De todos los “good” reales, % que capturas.
- ¿Qué es F1? Media armónica de precisión y recall.
- ¿Qué es Coverage? % del dataset cubierto por la regla (volumen).
- ¿Qué es Lift? Precision / Baseline. “Veces mejor que el azar”.
- ¿Por qué veo ∞? Indica umbral sin tope (sin límite superior).
- ¿Decimales? En `.env` siempre con punto, el HTML ya usa formato de máquina para el snippet.

---

### 6) Workflows sugeridos

1. Exploración inicial (Etapa 1):

- `npm run split:summaries` → `npm run analyze:good` → abre `analysis-output/report.html`.
- Copia el snippet `.env` del preset que prefieras (F1/precisión/recall) y pruébalo en runtime.

2. Estrategia robusta (Etapa 1 + 2):

- `npm run analyze:backtest` (sin BT_LIMIT) para resultados representativos.
- Revisa `backtest-report.html`, elige objetivo (por defecto F1) y copia el `.env` (incluye `TRACK_STAGE2_*`).
- Si quieres usar Etapa 2 en producción, implementamos la confirmación en runtime.

3. Afinar objetivos:

- Ejecuta backtest con `BT_OBJECTIVE=precision` y `BT_MIN_COVERAGE` para limitar la cobertura mínima.
- O usa `BT_OBJECTIVE=recall_min_precision` con `BT_MIN_PRECISION` para “max recall” con calidad mínima.

---

### 7) Dónde están los archivos

- Analysis: `analysis-output/report.html`, `summary_stats.csv`, `threshold_search.csv`, `threshold_top100.csv`, `recommended_rule.json`.
- Backtest: `backtest-output/backtest-report.html`, `backtest_results.csv`, `backtest_top_*.json`, `recommended_backtest_rule.json`.
- Partición de outcomes: `logs/summary-outcomes/*.jsonl`.

---

### 8) Notas finales

- Etapa 2 requiere tracking logs por token (`tracking/<mint>-websocket.log>`). Si no los tienes, puedes activar `TRACK_ALL_MINTS=true` temporalmente para recolectar datos (y luego volver a filtros).
- Si algo no te cuadra o necesitas presets con restricciones (p. ej., “max precision con coverage ≥ 10%”), lo podemos añadir al backtester.

---

### 9) Análisis por estrategia (strategies.json)

Si ejecutas la app con `strategies.json` (múltiples estrategias), cada sesión de tracking queda marcada con `strategyId` en `tracking-summaries.log`. Puedes sacar un resumen por estrategia con:

```
npm run analyze:strategies
```

- Salida: `analysis-output/strategies/strategy_metrics.csv` y `.json`, con por-estrategia:
    - positives: nº de sesiones (filas) marcadas con esa estrategia
    - uniqueTokens: nº de tokens distintos
    - goodPred / neutralPred / badPred: composición por outcome
    - precision / recall / f1 / coverage / lift (baseline calculada sobre el subconjunto “marcado”)

Notas:

- Si no hay `strategyId` en los summaries (logs antiguos), el resumen saldrá vacío. Debes arrancar la app con `strategies.json` y generar nuevos summaries.
- El script usa `logs/summary-outcomes/*.jsonl` si existen; si no, lee `logs/tracking-summaries.log` directamente.

- También se genera `analysis-output/strategies/report.html` con:
    - Tabla con métricas por estrategia (positives, uniqueTokens, good/neutral/bad, precision, recall, F1, coverage, lift).
    - Tarjetas por estrategia con chips de condiciones y snippet `.env` (Etapa 1) y botón “Copiar”.
    - Badges “sin datos aún” para estrategias sin summaries marcados y “logs: N” con conteo de ficheros `*-websocket.log` en su carpeta.

Notas importantes sobre estrategias:

- Si existe `strategies.json`, la app aplica esas estrategias. Los `TRACK_*` globales del `.env` actúan como estrategia por defecto solo si NO hay `strategies.json` (fallback).
- Cada estrategia puede definir su propio `tracking.logDir` para separar ficheros.

---

### 10) Variables de entorno (ENV) y uso actual

Resumen práctico:

- Activas y usadas hoy:
    - WebSocket/API: `PUMP_PORTAL_WS_URL`, `PUMP_PORTAL_API_KEY` (opcional).
    - Logging: `LOG_LEVEL`, `LOG_TIMEZONE`, `SUPPRESS_PUMP_WS_TRADE_PROCESSING_LOG`, `TRADE_LOG_SAMPLE_EVERY`, `TRADE_LOG_THROTTLE_MS`.
    - App: `MAX_RECONNECT_ATTEMPTS`, `RECONNECT_DELAY_MS`.
    - Precio: `COINGECKO_SOL_ENDPOINT`, `PRICE_REFRESH_MS`.
    - HTTP: `HTTP_PORT`.
    - Tracking (global): `TRACKING_ENABLED`, `TRACKING_ENTRY_DELAY_SEC`, `TRACKING_INACTIVITY_MIN`, `TRACKING_MAX_WINDOW_MIN`, `TRACKING_LOG_DIR`.
    - Summaries: `SUMMARIES_PRICE_DECIMALS`, `SUMMARIES_GOOD_THRESHOLD_PCT`, `SUMMARIES_BAD_THRESHOLD_PCT`.
    - Filtros Etapa 1 (fallback si no hay strategies.json): `TRACK_FILTERS_ENABLED`, `TRACK_ALL_MINTS`, `TRACK_MIN_*`, `TRACK_MAX_*`.
- Stage 2 (confirmación 30/60s): en los reportes verás `TRACK_STAGE2_*` como recomendación, pero NO están implementadas en runtime aún (solo backtest). No añadas estas variables al `.env` hasta que se implemente Etapa 2.
- Limpieza: se soportan exclusivamente `_SEC/_MIN` (se retiraron fallbacks legacy `_MS`).

Backtest de reglas:

- `BT_LIMIT`, `BT_OBJECTIVE`, `BT_MIN_PRECISION`, `BT_MIN_COVERAGE`, `BT_WORKERS`, `BT_TOPK`.

Wallet backtest:

- `BACKTEST_STRATEGY_ID`, `BACKTEST_INITIAL_SOL`, `BACKTEST_ALLOC_SOL`, `BACKTEST_ALLOC_PCT`,
  `BACKTEST_TP_PCT`, `BACKTEST_SL_PCT`, `BACKTEST_TIMEOUT_SEC`, `BACKTEST_FEE_PCT`, `BACKTEST_SLIPPAGE_PCT`,
  `BACKTEST_LIMIT`, `BACKTEST_PARSE_CONCURRENCY`.
- Variables prescindibles hoy:
    - `TRACKING_TP_PCT`: se carga en config pero no se usa en el código.
    - `MONITOR_CREATOR_SELLS`: actualmente solo habilita logs informativos; no altera el flujo (opcional mantener, se puede retirar si no aporta).

Sugerencia: si vas a operar siempre con `strategies.json`, prioriza mantener ahí tus umbrales. Los `TRACK_*` globales quedarán como fallback para entornos sin fichero de estrategias.
