import DefaultTheme from 'vitepress/theme';
import { h } from 'vue';
import DocFooter from './DocFooter.vue';
import './style.css';

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      'doc-after': () => h(DocFooter),
    });
  },
};
