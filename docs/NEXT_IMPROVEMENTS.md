## NEXT IMPROVEMENTS

Una lista priorizada de mejoras para aumentar recall sin perder precisión, reducir falsos positivos y facilitar operación.

---

### 1) Confirmación en runtime (Etapa 2)

- Implementar en la app los ENV sugeridos por backtest:
    - `TRACK_STAGE2_ENABLED`
    - `TRACK_STAGE2_WINDOW_SEC` (30/60)
    - `TRACK_STAGE2_MIN_TRADES`
    - `TRACK_STAGE2_MIN_MAXPCT`
- Flujo: tras arrancar tracking por creator sell+Etapa 1, esperar la ventana y confirmar (trades o maxPct). Si no confirma, no alertar o cancelar.
- Beneficio: recorta neutrales/bad manteniendo buena cobertura.

---

### 2) Presets avanzados y objetivos

- Añadir al backtest más objetivos con constraints:
    - Max recall con precisión ≥ X% (configurable)
    - Max precisión con coverage ≥ Y% (configurable)
    - Max utilidad: `U = α·TP − β·FP_bad − γ·FP_neutral` con α, β, γ en ENV
- Añadir a los reportes HTML presets específicos (F1, Precision@Cov, Recall@Prec, Utilidad) con snippet `.env` asociado.

---

### 3) Ensembles (OR de reglas)

- Buscar 2–3 reglas complementarias por segmentos (MC, edad) y combinar con OR para subir recall sin disparar FP.
- Mostrar en HTML el ensemble resultante con su snippet `.env` (Etapa 1) y Etapa 2 recomendada.

---

### 4) Señales temporales enriquecidas

- Enriquecer tracking logs con métricas por minuto y aceleraciones:
    - buys/min, trades/min, unique/min (normalizados por `ageAtTriggerSec`)
    - accel\* en ventanas cortas (15–30s) para Etapa 2
- Añadir umbrales Stage2 basados en rates (p.ej., `trades/min ≥ N`, `buys/min ≥ M`).

---

### 5) Validación robusta

- Holdout temporal (train/test por fecha) para evitar fuga de info.
- Deduplicación por token (usar sólo primer/último summary si hay duplicados por ventanas cercanas).
- Reportar matriz de confusión completa y composición de FP (neutral vs bad) en todos los presets.

---

### 6) UX de reportes

- Botón “Copiar .env” también para filas del Top (no solo el recomendado).
- Filtros interactivos en HTML (rango de MC, edad) y recálculo client-side sobre versiones reducidas.
- Exportar CSV/JSON desde el HTML (descargas on‑the‑fly de tablas filtradas).

---

### 7) Observabilidad y endpoints

- Exponer `trackingFilters` y Stage2 en `/status` y `/stats` (hecho para Stage1; añadir Stage2 cuando exista runtime).
- Endpoint `/backtest/preset` que devuelva el preset recomendado actual.

---

### 8) Calidad de datos y limpieza

- Identificar sesiones con datos incompletos (sin logs de ventana) y contabilizar impacto.
- Manejo de outliers (MC extremos, ratios imposibles) con winsorization ligera para la búsqueda de umbrales.

Limpieza de código/ENV (estado):

- [hecho] Retirados fallbacks `*_MS`; ahora solo `_SEC/_MIN`.
- [pendiente] Retirar `TRACKING_TP_PCT` (no se usa) del `.env` y de `config`.
- [pendiente] Eliminar funciones de `account trades` si no se usan.
- [hecho] Aclarado en docs que `TRACK_*` globales son fallback cuando hay `strategies.json`.

---

### 9) Integración continua de datos

- Job programado para ejecutar backtest diariamente/semanalmente, publicar `recommended_backtest_rule.json` y el HTML en artefactos de CI.
- Enviar alertas cuando cambie significativamente el preset recomendado (dif de precisión/recall ≥ umbral).

---

### 10) Futuro: modelado ligero

---

### 11) Estado actual de backtesting

- [hecho] Backtest multi‑worker en `analyze:backtest` (BT_WORKERS, BT_TOPK, CSV streaming).
- [hecho] Wallet backtest secuencial por estrategia (`analyze:wallet`) con TP/SL/Timeout y fees/slippage.
- [hecho] Parser descarta sesiones sin summary.

- Sin salir de reglas interpretables, probar árboles pequeños (depth 2–3) para encontrar interacciones útiles y luego convertirlos a umbrales simples.
- Mantener enfoque de reglas para facilidad de operación y `.env` reproducible.
