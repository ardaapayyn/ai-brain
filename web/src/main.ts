import './styles/main.css';
import { App } from './app';

function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

if (!webglAvailable()) {
  document.getElementById('ui')!.innerHTML =
    '<div class="welcome glass" style="bottom:45%"><h3>WebGL non disponibile</h3><p>Abilita l’accelerazione hardware nel browser per vedere il cervello 3D.</p></div>';
} else {
  (window as any).brain = new App();
}
