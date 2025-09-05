const PumpPortalAnalyzer = require('../src/index');

// Ejemplo de uso programático de la aplicación
async function example() {
  const analyzer = new PumpPortalAnalyzer();

  // Iniciar el analizador
  await analyzer.start();

  // Obtener estado cada 60 segundos
  setInterval(() => {
    const status = analyzer.getStatus();
    console.log('📊 Estado actual:', status);
  }, 60000);

  // Detener después de 5 minutos (ejemplo)
  setTimeout(async () => {
    console.log('🛑 Deteniendo aplicación de ejemplo...');
    await analyzer.stop();
    process.exit(0);
  }, 300000); // 5 minutos
}

// Ejecutar el ejemplo si se llama directamente
if (require.main === module) {
  example().catch(console.error);
}

module.exports = example;
