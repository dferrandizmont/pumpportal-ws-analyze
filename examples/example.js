import PumpPortalAnalyzer from "../src/index.js";

// Ejemplo de uso programático de la aplicación
async function example() {
	const analyzer = new PumpPortalAnalyzer();

	// Iniciar el analizador
	await analyzer.start();

	// Obtener estado cada 60 segundos
	setInterval(() => {
		const status = analyzer.getStatus();
		console.info("Estado actual:", status);
	}, 60000);

	// Detener después de 5 minutos (ejemplo)
	setTimeout(async () => {
		console.info("Deteniendo aplicación de ejemplo...");
		await analyzer.stop();
		process.exit(0);
	}, 300000); // 5 minutos
}

// Ejecutar el ejemplo si se llama directamente (ESM)
if (import.meta.url === (process?.argv?.[1] ? new URL(`file://${process.argv[1]}`).href : "")) {
	example().catch(console.error);
}

export default example;
