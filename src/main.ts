/** エントリポイント。画面の中身は app.ts が組み立てる。 */
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/screens.css';
import { mount } from './app';

const root = document.querySelector<HTMLDivElement>('#app');
if (root) void mount(root);
