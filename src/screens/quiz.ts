/**
 * 出題画面と1問の結果（機能F・G・J）。
 *
 * 地図が主役。UIは上下の薄い帯と、地図の上に浮く「回答する」ボタン1つだけ。
 */
import {
  imageUrl,
  initialHeading,
  loadTrack,
  mountainOf,
  mountainView,
  type MapView,
} from '../data';
import { AnswerMap } from '../map/answerMap';
import { Terrain3D } from '../map/terrain3d';
import { formatRadius, visibleRadii } from '../map/rings';
import { CORRECT_THRESHOLD, play, playForScore } from '../sound';
import type { Answer, QuizSession } from '../session';
import type { QuizPoint } from '../types';
import { append, clear, el, formatDistance, formatPoints } from '../ui/dom';

export interface QuizScreenHandlers {
  /** 1問の結果が出るたび（進捗保存に使う） */
  onAnswered: (answer: Answer) => void;
  /** 全問終わったとき */
  onFinished: () => void;
  onQuit: () => void;
}

export interface QuizScreen {
  element: HTMLElement;
  destroy: () => void;
}


export function createQuizScreen(
  session: QuizSession,
  handlers: QuizScreenHandlers,
): QuizScreen {
  const root = el('div', { class: 'quiz' });

  const media = el('div', { class: 'quiz__media' });
  const answerArea = el('div', { class: 'quiz__answer' });
  const mapHost = el('div', { class: 'map' });
  append(answerArea, mapHost);
  append(root, media, answerArea);

  const first = session.current();
  if (!first) {
    return { element: root, destroy: () => undefined };
  }

  const answerMap = new AnswerMap(mapHost, {
    center: startView(first).center,
    zoom: startView(first).zoom,
    onGuessChange: () => {
      actionButton.disabled = false;
      hint.textContent = '置き直せます。「回答する」で確定';
    },
  });

  let terrain: Terrain3D | null = null;
  let terrainHost: HTMLElement | null = null;
  if (session.viewMode === 'terrain3d') {
    terrainHost = el('div', { class: 'quiz__terrain' });
    append(media, terrainHost);
    terrain = new Terrain3D(terrainHost, {
      center: { lat: first.lat, lon: first.lon },
      headingDeg: initialHeading(first),
      groundElevationM: first.elevation_m,
    });

    // 「自分がどこに立っているか」を一発で確かめられるようにする
    const view = terrain;
    const down = el('button', { class: 'terrain-btn', type: 'button' }, '真下を見る');
    const ahead = el('button', { class: 'terrain-btn', type: 'button' }, '水平に戻す');
    down.addEventListener('click', () => view.lookDown());
    ahead.addEventListener('click', () => view.lookAhead());
    append(terrainHost, el('div', { class: 'terrain-controls' }, down, ahead));
  }

  const photo = el('img', {
    class: 'quiz__photo',
    alt: 'この地点から撮影した1コマ。ここがどこかを地形図で当てます。',
  }) as HTMLImageElement;

  const hint = el(
    'div',
    { class: 'map__hint' },
    'このルートのどこかです。地形図をタップして推測地点を置く',
  );
  const actionButton = el(
    'button',
    { class: 'btn btn--primary quiz__action', type: 'button', disabled: true },
    '回答する',
  ) as HTMLButtonElement;
  append(answerArea, hint, actionButton);

  let resultPanel: HTMLElement | null = null;
  let shownTrackId: string | null = null;

  /** 山が変わったときだけトラックを読み直して地形図に重ねる。 */
  async function syncTrack(point: QuizPoint): Promise<void> {
    if (shownTrackId === point.mountain_id) return;
    shownTrackId = point.mountain_id;
    const track = await loadTrack(mountainOf(session.data, point));
    // 読み込み中に次の問題へ進んで山が変わっていたら捨てる
    if (shownTrackId !== point.mountain_id) return;
    answerMap.showTrack(track);
  }

  /**
   * 出題開始時の地図。**正解地点を中心にしない**（画面中央がそのまま答えになる）。
   * 山ごとに固定の範囲を出すので、どの問題も同じ画から始まる。
   */
  function startView(point: QuizPoint): MapView {
    return mountainView(session.data, point.mountain_id);
  }

  function renderMedia(point: QuizPoint): void {
    const url = imageUrl(point);
    // 画像ノードは使い回す（3Dビューの下に写真が入る構成）
    if (url) {
      photo.src = url;
      photo.loading = 'eager';
      if (!photo.isConnected) media.insertBefore(photo, media.firstChild);
    } else {
      photo.remove();
      if (session.viewMode === 'terrain3d' && !media.querySelector('.media-note')) {
        media.insertBefore(
          el(
            'p',
            { class: 'media-note' },
            'この地点は写真がありません。3D地形だけを手がかりに位置を当ててください。',
          ),
          media.firstChild,
        );
      }
    }
  }

  function renderQuestion(): void {
    const point = session.current();
    if (!point) return;
    resultPanel?.remove();
    resultPanel = null;
    actionButton.disabled = true;
    actionButton.textContent = '回答する';
    actionButton.hidden = false;
    hint.hidden = false;
    hint.textContent = 'このルートのどこかです。地形図をタップして推測地点を置く';
    renderMedia(point);
    const view = startView(point);
    answerMap.reset(view.center, view.zoom);
    void syncTrack(point);
    terrain?.moveTo(
      { lat: point.lat, lon: point.lon },
      initialHeading(point),
      point.elevation_m,
    );
    window.requestAnimationFrame(() => {
      answerMap.resize();
      terrain?.resize();
    });
  }

  function showResult(answer: Answer, point: QuizPoint): void {
    const near = answer.points >= CORRECT_THRESHOLD;
    const ring = visibleRadii(answer.distanceM).find((r) => r >= answer.distanceM);
    const isLast = session.index + 1 >= session.total;

    const panel = el('div', { class: 'result', role: 'status', 'aria-live': 'polite' });
    const score = el(
      'div',
      { class: 'result__score' },
      el(
        'span',
        { class: `result__points ${near ? 'result__points--near' : 'result__points--far'}` },
        formatPoints(answer.points),
      ),
      el('span', { class: 'result__unit' }, '点'),
      el('span', { class: 'spacer' }),
      el(
        'button',
        { class: 'btn btn--primary', type: 'button', id: 'yg-next' },
        isLast ? '結果を見る' : '次の問題',
      ),
    );
    const facts = el(
      'div',
      { class: 'result__facts' },
      el('span', {}, '外れた距離 ', el('b', {}, formatDistance(answer.distanceM))),
      ring !== undefined
        ? el('span', {}, `${formatRadius(ring)}リングの内側`)
        : el('span', {}, 'リングの外側'),
      el('span', {}, near ? 'かなり近い' : 'もっと近づけます'),
    );
    append(panel, score, facts);
    append(answerArea, panel);
    resultPanel = panel;

    // 「次へ」の導線は地図の描画より先に配線する。
    // 地図側で何かあってもゲームが進めなくなることがないように。
    const next = panel.querySelector<HTMLButtonElement>('#yg-next');
    next?.addEventListener('click', () => {
      if (session.advance()) {
        renderQuestion();
      } else {
        play('finish');
        handlers.onFinished();
      }
    });
    next?.focus();

    answerMap.reveal({ lat: point.lat, lon: point.lon }, answer.distanceM);
    playForScore(answer.points);
  }

  actionButton.addEventListener('click', () => {
    const guess = answerMap.getGuess();
    const point = session.current();
    if (!guess || !point) return;
    const answer = session.submit(guess);
    actionButton.hidden = true;
    hint.hidden = true;
    handlers.onAnswered(answer);
    showResult(answer, point);
  });

  renderQuestion();

  const onResize = (): void => {
    answerMap.resize();
    terrain?.resize();
  };
  window.addEventListener('resize', onResize);

  return {
    element: root,
    destroy: () => {
      window.removeEventListener('resize', onResize);
      answerMap.destroy();
      terrain?.destroy();
      clear(root);
      handlers.onQuit();
    },
  };
}
