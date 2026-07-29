/**
 * 出題画面と1問の結果（機能F・G・J）。
 *
 * 地図が主役。UIは上下の薄い帯と、地図の上に浮く「回答する」ボタン1つだけ。
 */
import {
  imageUrls,
  initialHeading,
  loadTrack,
  mountainOf,
  mountainView,
  type MapView,
} from '../data';
import { AnswerMap } from '../map/answerMap';
import { PRESETS, Terrain3D, type ViewPreset } from '../map/terrain3d';
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
    const presetButtons = new Map<ViewPreset, HTMLButtonElement>();
    const syncPresetButtons = (active: ViewPreset): void => {
      for (const [key, button] of presetButtons) {
        button.setAttribute('aria-pressed', String(key === active));
      }
    };

    terrain = new Terrain3D(terrainHost, {
      center: { lat: first.lat, lon: first.lon },
      headingDeg: initialHeading(first),
      groundElevationM: first.elevation_m,
      onPresetChange: syncPresetButtons,
    });

    // 視点モードの切り替えと、「自分がどこに立っているか」の確認
    const view = terrain;
    const controls = el('div', { class: 'terrain-controls', role: 'group', 'aria-label': '視点' });
    for (const key of ['first_person', 'overhead'] as ViewPreset[]) {
      const preset = PRESETS[key];
      const button = el(
        'button',
        {
          class: 'terrain-btn',
          type: 'button',
          'aria-pressed': String(key === view.currentPreset()),
          title: preset.hint,
        },
        preset.label,
      ) as HTMLButtonElement;
      button.addEventListener('click', () => view.setPreset(key));
      presetButtons.set(key, button);
      append(controls, button);
    }
    const down = el('button', { class: 'terrain-btn', type: 'button' }, '真下');
    down.addEventListener('click', () => {
      view.lookDown();
      syncPresetButtons(view.currentPreset());
    });
    append(controls, down);
    append(terrainHost, controls);
    append(
      terrainHost,
      el('p', { class: 'terrain-legend' }, Terrain3D.routeLegend()),
    );
  }

  const photo = el('img', {
    class: 'quiz__photo',
    alt: 'この地点で撮影した1枚。ここがどこかを地形図で当てます。',
  }) as HTMLImageElement;
  const thumbs = el('div', { class: 'quiz__thumbs', role: 'tablist', 'aria-label': '画像' });
  const photoBox = el('div', { class: 'quiz__photobox' }, photo, thumbs);

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

  /** 山が変わったときだけトラックを読み直し、地形図と3Dの両方に渡す。 */
  async function syncTrack(point: QuizPoint): Promise<void> {
    if (shownTrackId === point.mountain_id) return;
    shownTrackId = point.mountain_id;
    const track = await loadTrack(mountainOf(session.data, point));
    // 読み込み中に次の問題へ進んで山が変わっていたら捨てる
    if (shownTrackId !== point.mountain_id) return;
    answerMap.showTrack(track);
    terrain?.setTrack(track);
  }

  /**
   * 出題開始時の地図。**正解地点を中心にしない**（画面中央がそのまま答えになる）。
   * 山ごとに固定の範囲を出すので、どの問題も同じ画から始まる。
   */
  function startView(point: QuizPoint): MapView {
    return mountainView(session.data, point.mountain_id);
  }

  /**
   * その地点の画像を出す。1地点に複数枚あることがあるので、
   * 2枚以上なら下にサムネイルを並べて切り替えられるようにする。
   */
  function renderMedia(point: QuizPoint): void {
    const urls = imageUrls(point);
    media.querySelector('.media-note')?.remove();

    if (urls.length === 0) {
      photoBox.remove();
      if (session.viewMode === 'terrain3d') {
        media.insertBefore(
          el(
            'p',
            { class: 'media-note' },
            'この地点は写真がありません。3D地形だけを手がかりに位置を当ててください。',
          ),
          media.firstChild,
        );
      }
      return;
    }

    const show = (index: number): void => {
      photo.src = urls[index] ?? '';
      photo.loading = 'eager';
      for (const [i, node] of [...thumbs.children].entries()) {
        node.setAttribute('aria-selected', String(i === index));
      }
    };

    clear(thumbs);
    if (urls.length > 1) {
      urls.forEach((url, i) => {
        const thumb = el('button', {
          class: 'quiz__thumb',
          type: 'button',
          role: 'tab',
          'aria-selected': String(i === 0),
          'aria-label': `${i + 1}枚目を見る（全${urls.length}枚）`,
        });
        thumb.style.backgroundImage = `url("${url}")`;
        thumb.addEventListener('click', () => show(i));
        append(thumbs, thumb);
      });
    }
    thumbs.hidden = urls.length <= 1;
    if (!photoBox.isConnected) media.insertBefore(photoBox, media.firstChild);
    show(0);
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
