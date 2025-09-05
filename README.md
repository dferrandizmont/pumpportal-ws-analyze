# PumpPortal Token Analyzer

Una aplicación Node.js que se conecta al WebSocket de PumpPortal para monitorear tokens nuevos y detectar cuando los creadores venden sus tokens.

## 🚀 Características

- **Monitoreo en tiempo real** de nuevos tokens en PumpPortal
- **Detección de ventas de creadores** con alertas configurables
- **Logging estructurado** con Winston y timestamps en zona horaria de Madrid
- **Reconección automática** en caso de pérdida de conexión
- **Configuración flexible** mediante variables de entorno
- **Alertas por consola** cuando se detectan ventas significativas

## 📋 Requisitos

- Node.js >= 16.0.0
- Yarn o npm
- Conexión a internet

## 🛠️ Instalación

```bash
# Clona el repositorio
git clone <repository-url>
cd pumpportal-ws-analyze

# Instala las dependencias
yarn install
```

## ⚙️ Configuración

### Archivo de Configuración

Copia el archivo de ejemplo y configúralo según tus necesidades:

```bash
# Copiar el archivo de ejemplo
cp .env.example .env

# Editar el archivo .env con tus configuraciones
# nano .env  # o tu editor favorito
```

### Variables de Entorno

```env
# PumpPortal WebSocket Configuration
PUMP_PORTAL_WS_URL=wss://pumpportal.fun/api/data

# Logging Configuration
LOG_LEVEL=info
LOG_TIMEZONE=Europe/Madrid

# Application Configuration
MAX_RECONNECT_ATTEMPTS=10
RECONNECT_DELAY_MS=5000
MONITOR_CREATOR_SELLS=true

# Threshold for creator sell detection (percentage of creator-held tokens)
CREATOR_SELL_THRESHOLD=80.0

# Optional: API Key for PumpPortal (if needed for premium features)
# PUMP_PORTAL_API_KEY=your-api-key-here
```

### Configuraciones Recomendadas

#### Para Desarrollo
```env
LOG_LEVEL=debug
MONITOR_CREATOR_SELLS=true
CREATOR_SELL_THRESHOLD=50.0
```

#### Para Producción
```env
LOG_LEVEL=warn
MONITOR_CREATOR_SELLS=true
CREATOR_SELL_THRESHOLD=80.0
```

#### Para Testing
```env
LOG_LEVEL=info
MONITOR_CREATOR_SELLS=false
```

### Sistema de Alertas

#### Archivo de Alertas Dedicado
Cuando se supera el umbral de ventas, se genera automáticamente una entrada en:
```
logs/creator-sell-alerts.log
```

#### Formato de Alerta
```
DD-MM-YYYY HH:mm:ss.SSS INFO 🚨 ALERT: Creator sold X.XX% of tokens in TOKEN_NAME
{
  "creatorAddress": "...",
  "tokenAddress": "...",
  "tokenName": "TOKEN_NAME",
  "sellPercentage": "85.50",
  "threshold": 80,
  "totalSold": 123456,
  "totalOwned": 144567,
  "lastSellTime": "2025-01-XX...",
  "totalSellsInHistory": 3
}
```

#### Monitoreo en Tiempo Real
- ✅ **Consola**: Alertas inmediatas con emojis 🚨
- ✅ **Archivo principal**: Logs en `pumpportal-monitor.log`
- ✅ **Archivo dedicado**: Historial completo en `creator-sell-alerts.log`

## 🚀 Uso

```bash
# Iniciar la aplicación
yarn start

# Modo desarrollo con reinicio automático
yarn dev

# Ejecutar ejemplo programático
node examples/example.js
```

### Consultas Remotas (Sin Logs Automáticos)

```bash
# Consultar estado detallado desde otra terminal
yarn status status

# Ver estadísticas rápidas
yarn status stats

# Verificar salud del sistema
yarn status health

# Mostrar ayuda
node status-client.js help
```

## 🌐 Consulta Remota desde Otra Terminal

La aplicación incluye un servidor HTTP que permite consultar el estado desde otras terminales **sin generar logs automáticos** en la aplicación principal. Todo el monitoreo de estado es accesible únicamente a través de consultas HTTP remotas.

> **⚠️ Importante**: La aplicación **NO genera logs automáticos** de estado cada X tiempo y **NO tiene comandos interactivos**. Toda la información de monitoreo solo está disponible mediante consultas explícitas al servidor HTTP desde otras terminales usando el cliente `status-client.js`.

### Endpoints HTTP

Una vez iniciada la aplicación, estarán disponibles los siguientes endpoints:

```bash
# Estado detallado de todos los tokens
curl http://localhost:3000/status

# Estadísticas rápidas
curl http://localhost:3000/stats

# Verificación de salud
curl http://localhost:3000/health
```

### Cliente de Línea de Comandos

También incluye un cliente dedicado para consultas desde otra terminal:

```bash
# Mostrar estado detallado
node status-client.js status

# Mostrar estadísticas rápidas
node status-client.js stats

# Verificación de salud
node status-client.js health

# Modo de monitoreo continuo (actualiza cada 5 segundos)
node status-client.js watch

# Modo de monitoreo continuo cada 10 segundos
node status-client.js watch 10

# Mostrar ayuda
node status-client.js help
```

### Ejemplo de Salida

```bash
$ node status-client.js stats

📈 === CURRENT STATISTICS === 📈
⏰ Timestamp: 9/5/2025, 10:55:30
⏱️  Uptime: 15m 30s
📊 Tokens monitored: 5
👥 Total creators: 5
🚨 Tokens over threshold: 0
💰 Total tokens owned: 247,863,000
📈 Total tokens sold: 0
📊 Average sell %: 0.00%
=====================================
```

## 📊 Funcionalidades

### Monitoreo de Nuevos Tokens
- Se suscribe automáticamente a eventos de creación de nuevos tokens
- Registra información detallada de cada token (nombre, símbolo, creador, supply)
- Monitorea trades en tiempo real para cada token

### Detección de Ventas de Creadores
- Monitorea las ventas realizadas por los creadores de tokens (basado en su posición real)
- El porcentaje se calcula sobre el total de tokens adquiridos por el creador (compra inicial + compras posteriores)
- Configurable el porcentaje umbral de venta (por defecto 80%)
- Alertas visuales cuando se supera el umbral
- **Archivo dedicado de alertas**: `logs/creator-sell-alerts.log`
- Tracking histórico de ventas por token individual
- **Detección robusta**: Funciona a través de token trades (no depende de account trades)

### Logging
- Logs estructurados con timestamps en zona horaria de Madrid
- Niveles de logging configurables (error, warn, info, debug)
- Archivos de log separados para output general y errores
- Prefijos de componentes para fácil identificación

## 🏗️ Arquitectura

```
pumpportal-ws-analyze/
├── src/                    # Código fuente principal
│   ├── index.js            # 🚀 Punto de entrada principal
│   ├── config.js           # ⚙️ Configuración centralizada
│   ├── logger.js           # 📝 Utilidad de logging con Winston
│   ├── pumpportal-ws-client.js # 🔌 Cliente WebSocket para PumpPortal
│   ├── token-monitor.js    # 👀 Lógica de monitoreo de tokens
│   └── utils.js            # 🛠️ Utilidades adicionales
├── examples/               # Ejemplos de uso
│   └── example.js          # 💡 Ejemplo de uso programático
├── logs/                   # Archivos de log
│   ├── pumpportal-monitor.log
│   ├── pumpportal-monitor-error.log
│   └── creator-sell-alerts.log
├── package.json           # 📦 Dependencias y scripts
├── .env                   # 🔐 Variables de entorno
├── .gitignore             # 🚫 Archivos ignorados
└── README.md              # 📖 Esta documentación
```

## 📝 Ejemplo de Output

```
23-12-2024 15:30:45.123 INFO [PUMP_WS] Successfully connected to PumpPortal WebSocket
23-12-2024 15:30:45.124 INFO [TOKEN_MONITOR] New token detected: MyToken (MTK)
23-12-2024 15:30:46.456 INFO [TOKEN_MONITOR] Trade detected: SELL
23-12-2024 15:30:46.457 WARN [CREATOR_SELL] Creator sell detected
🚨 ALERT: Creator ABC123... has sold 85.50% of tokens for MyToken (MTK)!
```

## 🔧 Configuración Avanzada

### Variables de Entorno

| Variable | Descripción | Valor por defecto |
|----------|-------------|-------------------|
| `PUMP_PORTAL_WS_URL` | URL del WebSocket de PumpPortal | `wss://pumpportal.fun/api/data` |
| `LOG_LEVEL` | Nivel de logging | `info` |
| `LOG_TIMEZONE` | Zona horaria para timestamps | `Europe/Madrid` |
| `MAX_RECONNECT_ATTEMPTS` | Máximo número de reintentos de conexión | `10` |
| `RECONNECT_DELAY_MS` | Delay entre reintentos (ms) | `5000` |
| `MONITOR_CREATOR_SELLS` | Habilitar monitoreo de ventas de creadores | `true` |
| `CREATOR_SELL_THRESHOLD` | Umbral de venta para alertas (%) | `80.0` |

## 🛡️ Manejo de Errores

- **Reconección automática** con backoff exponencial
- **Logging de errores** detallado
- **Graceful shutdown** en señales del sistema
- **Validación de datos** de mensajes WebSocket

## 📈 Estadísticas

La aplicación proporciona estadísticas periódicas cada 30 segundos:

- Total de tokens monitoreados
- Total de creadores rastreados
- Total de ventas de creadores detectadas
- Alertas activas

## 🤝 Contribución

1. Fork el proyecto
2. Crea una rama para tu feature (`git checkout -b feature/AmazingFeature`)
3. Commit tus cambios (`git commit -m 'Add some AmazingFeature'`)
4. Push a la rama (`git push origin feature/AmazingFeature`)
5. Abre un Pull Request

## 📄 Licencia

Este proyecto está bajo la Licencia MIT. Ver el archivo `LICENSE` para más detalles.

## ⚠️ Descargo de Responsabilidad

Esta aplicación es para fines educativos e informativos. No constituye asesoramiento financiero. El trading de criptomonedas implica riesgos significativos y puede resultar en pérdidas financieras.
