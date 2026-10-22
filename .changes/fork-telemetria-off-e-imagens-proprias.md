---
impacto: nada_mudou
secao: alterado
titulo: Relatórios de erro desligados de fábrica e imagens publicadas pelo próprio repositório
---
O instalador não pergunta mais sobre telemetria: sem SENTRY_DSN no .env, nenhum relatório de erro sai da instalação. Quem tiver o próprio Sentry põe SENTRY_DSN=<dsn>. As imagens, a clonagem e a busca de versões passam a apontar para jvsantos0811-ship-it/DeskcommCRM. Instalações existentes mantêm a imagem gravada no .env até a próxima atualização.
