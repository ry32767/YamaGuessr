/**
 * 出題画面と1問の結果（機能F・G・J）。
 *
 * **「見る」と「答える」を1画面ずつに分ける。** 3Dの地形も地形図もそれ自体が読む対象
 * なので、同じ画面に半分ずつ置くとどちらも読めない。上のタブで切り替え、
 * どちらも画面いっぱいに使う（DESIGN.md「地図が主役」）。
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
import { STEP_M, Terrain3D, type WalkState } from '../map/terrain3d';
import { TerrainModel } from '../map/terrainModel';
import { formatRadius, visibleRadii } from '../map/rings';
import { TIME_LIMIT_S, formatClock, remainingSeconds, timeFactor } from '../scoring';
import { CORRECT_THRESHOLD, play, playForScore } from '../sound';
import type { Answer, QuizSession } from '../session';
import type { QuizPoint } from '../types';
import { append, clear, el, formatDistance, formatPoints } from '../ui/dom';

export interface QuizScreenHandlers {
  /** 1問の結果が出るたび（進捗保存に使う） */
  onAnswered: (answer: Answer) => void;
  /** 出題が切り替わるたび（ヘッダーの「何問目」を合わせるため） */
  onQuestionShown?: () => void;
  /** 全問終わったとき */
  onFinished: () => void;
  onQuit: () => void;
}

export interface QuizScreen {
  element: HTMLElement;
  destroy: () => void;
}

type Pane = 'view' | 'answer';

export function createQuizScreen(
  session: QuizSession,
  handlers: QuizScreenHandlers,
): QuizScreen {
  const root = el('div', { class: 'quiz' });
  const firstPerson = session.viewMode === 'map2d';

  // --- 「見る」と「答える」を切り替えるタブ -----------------------------------
  const viewTab = el(
    'button',
    {
      class: 'quiz__tab',
      type: 'button',
      role: 'tab',
      'aria-selected': 'true',
      'aria-controls': 'yg-pane-view',
    },
    firstPerson ? '見る（3D・写真）' : '見る（3Dモデル）',
  ) as HTMLButtonElement;
  const answerTab = el(
    'button',
    {
      class: 'quiz__tab',
      type: 'button',
      role: 'tab',
      'aria-selected': 'false',
      'aria-controls': 'yg-pane-answer',
    },
    '答える（地形図）',
  ) as HTMLButtonElement;
  const tabs = el(
    'div',
    { class: 'quiz__tabs', role: 'tablist', 'aria-label': '出題画面の切り替え' },
    viewTab,
    answerTab,
  );

  // --- 持ち時間。**タブの下に置いて、見る側でも答える側でも常に見える** ---------
  const timerClock = el('b', { class: 'num' }, formatClock(TIME_LIMIT_S));
  const timerFill = el('i');
  const timerBar = el('span', { class: 'quiz__timerbar' }, timerFill);
  const timerRate = el('span', { class: 'quiz__timerrate num' }, '×100%');
  const timer = el(
    'div',
    { class: 'quiz__timer', role: 'timer', 'aria-label': '残り時間' },
    timerClock,
    el('span', { class: 'quiz__timerlabel' }, '残り'),
    timerBar,
    timerRate,
  );

  // --- 時間の勘定。3Dを作るより先に用意する（3Dは作った瞬間に歩行状態を通知する） ---
  /** この問題を出した時刻 */
  let questionStartedAt = performance.now();
  /** 回答して時間が止まったか */
  let timeStopped = false;
  /** 止めたときの実時間 [秒] */
  let stoppedElapsedS = 0;
  /** 歩いたぶんの秒数（3Dから受け取る） */
  let walkedSeconds = 0;

  /** 使った時間 [秒]＝画面を見ていた実時間 ＋ 歩いた時間。 */
  function usedSeconds(): number {
    const elapsed = timeStopped ? stoppedElapsedS : (performance.now() - questionStartedAt) / 1000;
    return elapsed + walkedSeconds;
  }

  function renderTimer(): void {
    const used = usedSeconds();
    const factor = timeFactor(used);
    timerClock.textContent = factor <= 0 ? '時間切れ' : formatClock(remainingSeconds(used));
    timerFill.style.width = `${factor * 100}%`;
    timerRate.textContent = `×${Math.round(factor * 100)}%`;
    timer.classList.toggle('quiz__timer--low', factor <= 0.25);
    timer.classList.toggle('quiz__timer--out', factor <= 0);
  }

  const timerTick = window.setInterval(() => {
    if (!timeStopped) renderTimer();
  }, 250);

  const media = el('div', {
    class: 'quiz__pane quiz__pane--view',
    id: 'yg-pane-view',
    role: 'tabpanel',
    'aria-label': '見る',
  });
  const answerArea = el('div', {
    class: 'quiz__pane quiz__pane--answer',
    id: 'yg-pane-answer',
    role: 'tabpanel',
    'aria-label': '答える',
  });
  const mapHost = el('div', { class: 'map' });
  append(answerArea, mapHost);
  append(root, tabs, timer, media, answerArea);

  let pane: Pane = 'view';
  function showPane(next: Pane): void {
    pane = next;
    viewTab.setAttribute('aria-selected', String(next === 'view'));
    answerTab.setAttribute('aria-selected', String(next === 'answer'));
    media.hidden = next !== 'view';
    answerArea.hidden = next !== 'answer';
    // 隠れている間の地図はサイズを持たない。表示に切り替えた側で必ず測り直す
    window.requestAnimationFrame(() => {
      if (pane === 'answer') answerMap.resize();
      else {
        terrain?.resize();
        model?.resize();
      }
    });
  }
  viewTab.addEventListener('click', () => showPane('view'));
  answerTab.addEventListener('click', () => showPane('answer'));

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

  // --- 見る側：一人称（地形図当て）か、3人称の地形モデル（3D地形当て）か -------
  let terrain: Terrain3D | null = null;
  let model: TerrainModel | null = null;
  const terrainHost = el('div', { class: 'quiz__terrain' });
  append(media, terrainHost);

  if (firstPerson) {
    // ルート上を歩く操作。ストリートビューと同じで、向いている方へ進む
    const back = el(
      'button',
      { class: 'terrain-btn', type: 'button', title: `${STEP_M}m 後ろへ` },
      '◀ 戻る',
    ) as HTMLButtonElement;
    const forward = el(
      'button',
      { class: 'terrain-btn', type: 'button', title: `見ている向きへ ${STEP_M}m` },
      '進む ▶',
    ) as HTMLButtonElement;
    const home = el(
      'button',
      { class: 'terrain-btn', type: 'button', title: '出発地点に戻る' },
      '出発地点',
    ) as HTMLButtonElement;

    const syncWalk = (state: WalkState): void => {
      for (const button of [back, forward]) button.disabled = !state.canWalk;
      home.disabled = !state.canWalk || state.movedM < 1;
      // 歩いたぶんはその場でタイマーに乗る（歩いた瞬間に残り時間が減る）
      walkedSeconds = state.seconds;
      renderTimer();
    };

    terrain = new Terrain3D(terrainHost, {
      center: { lat: first.lat, lon: first.lon },
      headingDeg: initialHeading(first),
      groundElevationM: first.elevation_m,
      onWalk: syncWalk,
    });

    const view = terrain;
    forward.addEventListener('click', () => view.walk(STEP_M));
    back.addEventListener('click', () => view.walk(-STEP_M));
    home.addEventListener('click', () => view.returnToStart());
    append(
      terrainHost,
      el(
        'div',
        { class: 'terrain-controls', role: 'group', 'aria-label': 'ルート上の移動' },
        back,
        forward,
        home,
      ),
      el('p', { class: 'terrain-legend' }, Terrain3D.routeLegend()),
    );
    syncWalk(view.walkState());
  } else {
    model = new TerrainModel(terrainHost, {
      center: { lat: first.lat, lon: first.lon },
      groundElevationM: first.elevation_m,
    });
    const view = model;
    const turnLeft = el(
      'button',
      { class: 'terrain-btn', type: 'button', title: '左に回り込む' },
      '◀ 回す',
    );
    const turnRight = el(
      'button',
      { class: 'terrain-btn', type: 'button', title: '右に回り込む' },
      '回す ▶',
    );
    const zoomIn = el('button', { class: 'terrain-btn', type: 'button', title: '寄る' }, '＋');
    const zoomOut = el('button', { class: 'terrain-btn', type: 'button', title: '引く' }, '−');
    const reset = el(
      'button',
      { class: 'terrain-btn', type: 'button', title: '北が上の見え方に戻す' },
      '北を上に',
    );
    turnLeft.addEventListener('click', () => view.turn(-30));
    turnRight.addEventListener('click', () => view.turn(30));
    zoomIn.addEventListener('click', () => view.zoom(0.5));
    zoomOut.addEventListener('click', () => view.zoom(-0.5));
    reset.addEventListener('click', () => view.resetView());
    append(
      terrainHost,
      el(
        'div',
        { class: 'terrain-controls', role: 'group', 'aria-label': '地形モデルの操作' },
        turnLeft,
        turnRight,
        zoomOut,
        zoomIn,
        reset,
      ),
      el('p', { class: 'terrain-legend' }, TerrainModel.legend()),
    );
  }

  // 見る側の唯一の主アクション。指の届く下に、3Dの操作ボタンと重ならない帯として置く
  const toAnswer = el(
    'button',
    { class: 'btn btn--primary btn--block', type: 'button' },
    '地形図で答える',
  );
  toAnswer.addEventListener('click', () => showPane('answer'));
  const viewFoot = el('div', { class: 'quiz__viewfoot' }, toAnswer);
  append(media, viewFoot);

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
    // 3人称（TerrainModel）にはルートを渡さない。地形図の朱線と形を見比べるだけで
    // 当たってしまい、地形を読む問題にならないため（docs/spec.md 設計判断表）
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
   *
   * 3人称モードでは写真を出さない（地形モデルだけを手がかりにする）。
   */
  function renderMedia(point: QuizPoint): void {
    const urls = firstPerson ? imageUrls(point) : [];
    media.querySelector('.media-note')?.remove();

    if (urls.length === 0) {
      photoBox.remove();
      if (firstPerson) {
        media.insertBefore(
          el(
            'p',
            { class: 'media-note' },
            'この地点は写真がありません。3D地形を見回して位置を当ててください。',
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
    viewFoot.hidden = false;
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
    model?.moveTo({ lat: point.lat, lon: point.lon }, point.elevation_m);
    // 新しい問題は必ず「見る」から始める
    showPane('view');
    // 持ち時間はここから。地図の読み込みを待たせないよう、画を出したこの時点で始める
    questionStartedAt = performance.now();
    stoppedElapsedS = 0;
    walkedSeconds = 0;
    timeStopped = false;
    timer.hidden = false;
    renderTimer();
    handlers.onQuestionShown?.();
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
    // 時間で何が起きたかを内訳で見せる（黙って掛けない）
    const walkNote =
      answer.walkSecondsS > 0
        ? `（見る ${formatClock(answer.elapsedS)}＋歩き ${formatClock(answer.walkSecondsS)}）`
        : '';
    append(
      facts,
      el(
        'span',
        { class: 'result__cost' },
        `かかった時間 ${formatClock(answer.totalTimeS)}${walkNote} → `,
        el('b', {}, `${formatPoints(answer.basePoints)}点 ×${Math.round(answer.timeFactor * 100)}%`),
      ),
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
    // ここで時間を止める。3Dで歩いたぶんも時間として乗る（機能E-2）
    stoppedElapsedS = (performance.now() - questionStartedAt) / 1000;
    timeStopped = true;
    renderTimer();
    const answer = session.submit(guess, terrain?.effort(), stoppedElapsedS);
    actionButton.hidden = true;
    hint.hidden = true;
    // 答え合わせは地形図の上で見せる。見る側からもう一度渡る導線は要らない
    viewFoot.hidden = true;
    handlers.onAnswered(answer);
    showResult(answer, point);
  });

  renderQuestion();

  const onResize = (): void => {
    if (pane === 'answer') answerMap.resize();
    else {
      terrain?.resize();
      model?.resize();
    }
  };
  window.addEventListener('resize', onResize);

  return {
    element: root,
    destroy: () => {
      window.clearInterval(timerTick);
      window.removeEventListener('resize', onResize);
      answerMap.destroy();
      terrain?.destroy();
      model?.destroy();
      clear(root);
      handlers.onQuit();
    },
  };
}
