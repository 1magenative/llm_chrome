import { defineConfig } from 'wxt';
import preact from '@preact/preset-vite';

export default defineConfig({
  srcDir: 'src',
  // Сборка в видимую папку dist/ вместо скрытой .output/.
  outDir: 'dist',
  vite: () => ({
    plugins: [preact()],
  }),
  manifest: {
    name: 'LLM Browser Agent',
    description: 'Агент, управляющий браузером через локальную LLM',
    // Агенту нужен доступ к любым страницам; это же разрешение покрывает
    // запросы к LLM-серверу с адресом из настроек (без CORS-проблем на стороне расширения).
    host_permissions: ['<all_urls>'],
    // scripting — внедрение content script по требованию, а не во все страницы подряд.
    // debugger — настоящие (isTrusted) клики и ввод через CDP, в том числе внутри iframe с других сайтов.
    // offscreen + notifications — звуковой сигнал и уведомление, когда ночью агенту нужно подтверждение.
    permissions: ['storage', 'sidePanel', 'scripting', 'debugger', 'offscreen', 'notifications'],
    action: {
      default_title: 'Открыть панель агента',
    },
  },
});
