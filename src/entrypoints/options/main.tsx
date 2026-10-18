import { render } from 'preact';
import '../../ui/base.css';
import './style.css';
import { App } from './App';

render(<App />, document.getElementById('app')!);
