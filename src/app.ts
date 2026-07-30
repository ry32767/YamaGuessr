/**
 * 画面の組み立てと遷移。
 *
 * フレームワークは足さない（AGENTS.md）。画面は「作って差し替える」だけの単純な
 * 切り替えで、状態はこのモジュールが持つ。
 */
import { QuizDataError, loadQuizData, playableCount } from './data';
import { MAX_SCORE } from './scoring';
import { CHALLENGE_COUNT, QuizSession, SessionError, describeEmpty } from './session';
import { isSoundEnabled, toggleSound } from './sound';
import {
  clearProgress,
  loadProgress,
  loadSettings,
  saveProgress,
  type Progress,
} from './storage';
import * as remote from './supabase';
import type { QuizScreen } from './screens/quiz';
import type { GameMode, QuizData, ViewMode } from './types';
import {
  append,
  clear,
  el,
  formatDistance,
  formatPoints,
  loadingBlock,
  stateBlock,
  toast,
} from './ui/dom';

interface Choice<T> {
  value: T;
  name: string;
  desc: string;
}

const MODE_CHOICES: Choice<GameMode>[] = [
  {
    value: 'challenge10',
    name: '10問チャレンジ',
    desc: `ランダムな${CHALLENGE_COUNT}問。合計点で勝負する`,
  },
  {
    value: 'complete_all',
    name: '全地点制覇',
    desc: '登録されている全地点を順に解く。途中でやめても再開できる',
  },
];

const VIEW_CHOICES: Choice<ViewMode>[] = [
  {
    value: 'map2d',
    name: '地形図当て',
    desc: '写真1枚だけを手がかりに、地形図上の位置を当てる',
  },
  {
    value: 'terrain3d',
    name: '3D地形当て',
    desc: '写真に加えて周辺の3D地形を見回せる。地名は出ない',
  },
];

/** 出題データ追加UI（`python pipeline/studio.py`）の待ち受け先。ローカル専用 */
const STUDIO_URL = 'http://127.0.0.1:8770/';

/**
 * ローカルで開いているか。
 *
 * studioへの導線はローカルのときだけ出す。studio自体は127.0.0.1にしか
 * 待ち受けないので公開先から辿れないが、リンクを出す意味も無い。
 */
function isLocalhost(): boolean {
  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

const TYPE_LABELS: Record<string, string> = {
  peak: 'ピーク',
  col: 'コル',
  ridge_view: '展望',
  ridge_start: '尾根に乗り始め',
  bend: '屈曲',
  manual: '手動追加',
  photo: '写真',
};

class App {
  private view: HTMLElement;
  private chrome: HTMLElement;
  private data: QuizData | null = null;
  private mode: GameMode = 'challenge10';
  private viewMode: ViewMode = 'map2d';
  /** 出題を絞る山（トラック）。null なら全部の山からまぜて出題する */
  private mountainId: string | null = null;
  private session: QuizSession | null = null;
  private quiz: QuizScreen | null = null;

  constructor(root: HTMLElement) {
    this.chrome = el('header', { class: 'chrome' });
    this.view = el('main', { class: 'view' });
    clear(root);
    append(root, this.chrome, this.view);
  }

  async start(): Promise<void> {
    this.renderChrome();
    this.setView(loadingBlock('出題データを読み込んでいます'));
    try {
      this.data = await loadQuizData();
    } catch (error) {
      const message =
        error instanceof QuizDataError ? error.message : '出題データを読み込めませんでした。';
      const retry = el('button', { class: 'btn', type: 'button' }, '再読み込み');
      retry.addEventListener('click', () => window.location.reload());
      this.setView(stateBlock('出題データがありません', message, retry));
      return;
    }
    void this.connect();
    this.showHome();
  }

  /** Supabase は繋がらなくてもよい。繋がったときだけリーダーボードを有効にする。 */
  private async connect(): Promise<void> {
    if (!remote.isConfigured()) return;
    const id = await remote.signIn();
    if (!id) return;
    await remote.syncNickname();
    if (!loadSettings().nickname) this.askNickname();
    this.renderChrome();
  }

  // -------------------------------------------------------------------------
  // 共通の枠
  // -------------------------------------------------------------------------
  private setView(node: HTMLElement): void {
    this.quiz?.destroy();
    this.quiz = null;
    clear(this.view);
    append(this.view, node);
  }

  private renderChrome(progress?: { index: number; total: number }): void {
    clear(this.chrome);
    // ボタン要素にすればキーボード操作もフォーカスも標準の挙動が効く
    const title = el(
      'button',
      { class: 'chrome__title', type: 'button', 'aria-label': 'ホームに戻る' },
      'Yama',
      el('span', {}, 'Guessr'),
    );
    title.addEventListener('click', () => this.confirmLeave());
    append(this.chrome, title);

    if (progress) {
      const bar = el('div', { class: 'progress__bar' }, el('i', {}));
      const fill = bar.querySelector('i');
      if (fill) fill.style.width = `${(progress.index / progress.total) * 100}%`;
      append(
        this.chrome,
        el(
          'div',
          { class: 'progress', 'aria-label': `全${progress.total}問中 ${progress.index + 1}問目` },
          el('b', {}, String(Math.min(progress.index + 1, progress.total))),
          '/',
          String(progress.total),
          bar,
        ),
      );
    }

    append(this.chrome, el('div', { class: 'spacer' }));

    const soundBtn = el(
      'button',
      {
        class: 'btn btn--ghost',
        type: 'button',
        'aria-pressed': String(isSoundEnabled()),
      },
      isSoundEnabled() ? '効果音 オン' : '効果音 オフ',
    );
    soundBtn.addEventListener('click', () => {
      toggleSound();
      this.renderChrome(progress);
    });
    append(this.chrome, soundBtn);

    if (remote.isConfigured()) {
      const nameBtn = el('button', { class: 'btn btn--ghost', type: 'button' }, remote.nickname());
      nameBtn.setAttribute('aria-label', `ニックネーム ${remote.nickname()}。変更する`);
      nameBtn.addEventListener('click', () => this.askNickname());
      append(this.chrome, nameBtn);
    }
  }

  private confirmLeave(): void {
    if (this.session && !this.session.finished && this.session.answered.length > 0) {
      const ok = window.confirm('プレイ中です。ホームに戻りますか？');
      if (!ok) return;
    }
    this.session = null;
    this.showHome();
  }

  // -------------------------------------------------------------------------
  // ホーム
  // -------------------------------------------------------------------------
  private showHome(): void {
    this.renderChrome();
    const home = el('div', { class: 'home' });
    const data = this.data;
    if (!data) return;

    append(
      home,
      el('h1', {}, '山の1コマから、いまどこかを当てる'),
      el(
        'p',
        { class: 'home__lead' },
        `登録されている地点は ${data.points.length} 箇所（${data.mountains.length} 山）。` +
          '写真か3D地形を見て、国土地理院の地形図をタップして答えます。',
      ),
    );

    append(
      home,
      this.choiceGroup('遊び方', MODE_CHOICES, this.mode, (v) => {
        this.mode = v;
        this.showHome();
      }),
    );
    append(
      home,
      this.choiceGroup('手がかり', VIEW_CHOICES, this.viewMode, (v) => {
        this.viewMode = v;
        this.showHome();
      }),
    );
    append(home, this.trackGroup(data));

    const playable = playableCount(data, this.viewMode, this.mountainId);

    const start = el(
      'button',
      { class: 'btn btn--primary btn--block', type: 'button', disabled: playable === 0 },
      playable > 0 ? `はじめる（${playable}地点から）` : 'はじめる',
    );
    start.addEventListener('click', () => this.startSession());
    append(home, start);

    if (playable === 0) {
      append(home, el('p', { class: 'muted tiny' }, describeEmpty(this.viewMode)));
    }

    // 中断した「全地点制覇」があれば再開を案内する
    const progress = loadProgress();
    if (progress && progress.answers.length > 0) {
      append(home, this.resumeCard(progress, data));
    }

    if (remote.isConfigured()) {
      const board = el(
        'button',
        { class: 'btn btn--ghost btn--block', type: 'button' },
        'リーダーボードを見る',
      );
      board.addEventListener('click', () => void this.showLeaderboard());
      append(home, board);
    }

    if (isLocalhost()) append(home, this.studioCard());

    append(
      home,
      el(
        'p',
        { class: 'muted tiny' },
        '正解データは静的ファイルとして配信される都合上、開発者ツールから閲覧できます。' +
          'リーダーボードは名誉制の参考記録です。',
      ),
    );

    this.setView(home);
  }

  private choiceGroup<T extends string>(
    label: string,
    choices: Choice<T>[],
    selected: T,
    onSelect: (value: T) => void,
  ): HTMLElement {
    const group = el('section', { class: 'stack' }, el('h2', {}, label));
    const list = el('div', { class: 'choices', role: 'group', 'aria-label': label });
    for (const choice of choices) {
      const button = el(
        'button',
        {
          class: 'choice',
          type: 'button',
          'aria-pressed': String(choice.value === selected),
        },
        el('span', { class: 'choice__name' }, choice.name),
        el('span', { class: 'choice__desc' }, choice.desc),
      );
      button.addEventListener('click', () => onSelect(choice.value));
      append(list, button);
    }
    append(group, list);
    return group;
  }

  /**
   * どのトラック（山）から出題するかを選ぶ。
   * 山が増えていくので、1山だけ遊ぶ／全部まぜる を選べるようにしてある。
   */
  private trackGroup(data: QuizData): HTMLElement {
    const group = el('section', { class: 'stack' }, el('h2', {}, 'コース'));
    const list = el('div', { class: 'tracks', role: 'group', 'aria-label': 'コース' });

    const makeButton = (
      id: string | null,
      name: string,
      detail: string,
      count: number,
    ): HTMLButtonElement => {
      const selected = this.mountainId === id;
      const button = el(
        'button',
        {
          class: 'track',
          type: 'button',
          'aria-pressed': String(selected),
          disabled: count === 0,
        },
        el('span', { class: 'track__name' }, name),
        el('span', { class: 'track__detail' }, detail),
        el('span', { class: 'track__count num' }, count === 0 ? '出題なし' : `${count}地点`),
      );
      button.addEventListener('click', () => {
        this.mountainId = id;
        this.showHome();
      });
      return button;
    };

    if (data.mountains.length > 1) {
      append(
        list,
        makeButton(
          null,
          'すべてのコース',
          `${data.mountains.length}コースからまぜて出題`,
          playableCount(data, this.viewMode, null),
        ),
      );
    }
    for (const mountain of [...data.mountains].sort((a, b) => a.id.localeCompare(b.id))) {
      const count = playableCount(data, this.viewMode, mountain.id);
      append(
        list,
        makeButton(
          mountain.id,
          mountain.name,
          mountain.track_path ? 'ルートを地形図に表示' : 'ルート未登録',
          count,
        ),
      );
    }
    append(group, list);
    return group;
  }

  /**
   * 出題データ追加UI（studio）への導線。**ローカルで開いたときだけ**出す。
   * GPX・動画・写真を放り込んで出題地点を作る作業はローカルでしかできない。
   */
  private studioCard(): HTMLElement {
    const link = el(
      'a',
      { class: 'btn btn--ghost btn--block', href: STUDIO_URL, target: '_blank', rel: 'noopener' },
      '出題データを追加する（studio）',
    );
    return el(
      'div',
      { class: 'panel stack' },
      el('b', {}, 'ローカル開発用'),
      link,
      el(
        'p',
        { class: 'muted tiny' },
        `開いていないときは \`python pipeline/studio.py\` で起動します（${STUDIO_URL} 固定・ローカル専用）。`,
      ),
    );
  }

  private resumeCard(progress: Progress, data: QuizData): HTMLElement {
    const stale = progress.datasetVersion !== data.dataset_version;
    const card = el(
      'div',
      { class: 'panel stack' },
      el('b', {}, '中断した「全地点制覇」があります'),
      el(
        'p',
        { class: 'muted tiny' },
        `${progress.answers.length} / ${progress.order.length} 問まで回答済み` +
          (stale ? '。ただし出題データが更新されています。' : '。'),
      ),
    );
    if (stale) {
      append(
        card,
        el(
          'p',
          { class: 'tiny' },
          '前回とデータの版が違うため、そのまま続けると出題内容がずれる可能性があります。',
        ),
      );
    }
    const buttons = el('div', { class: 'row' });
    const resume = el('button', { class: 'btn', type: 'button' }, '続きから');
    resume.addEventListener('click', () => this.resumeSession(progress));
    const reset = el('button', { class: 'btn btn--ghost', type: 'button' }, '進捗を捨てる');
    reset.addEventListener('click', () => {
      clearProgress();
      this.showHome();
    });
    append(buttons, resume, reset);
    append(card, buttons);
    return card;
  }

  // -------------------------------------------------------------------------
  // 出題
  // -------------------------------------------------------------------------
  private startSession(): void {
    const data = this.data;
    if (!data) return;
    try {
      const options = { mountainId: this.mountainId };
      this.session =
        this.mode === 'challenge10'
          ? QuizSession.challenge(data, this.viewMode, options)
          : QuizSession.completeAll(data, this.viewMode, options);
    } catch (error) {
      toast(error instanceof SessionError ? error.message : '出題を開始できませんでした', 'error');
      return;
    }
    if (this.mode === 'complete_all') {
      clearProgress();
      saveProgress(this.session.toProgress());
    }
    void this.renderQuiz();
  }

  private resumeSession(progress: Progress): void {
    const data = this.data;
    if (!data) return;
    const session = QuizSession.resume(data, progress);
    if (!session) {
      toast('保存された進捗を復元できませんでした。新しく始めてください。', 'error');
      clearProgress();
      this.showHome();
      return;
    }
    this.session = session;
    this.mode = session.mode;
    this.viewMode = session.viewMode;
    if (session.finished) {
      this.showSummary();
      return;
    }
    void this.renderQuiz();
  }

  /**
   * 出題画面を出す。
   *
   * 地図ライブラリはホーム画面では要らないので、ここで初めて読み込む
   * （初回表示を軽くするため。スマホの回線を考えると効く）。
   */
  private async renderQuiz(): Promise<void> {
    const session = this.session;
    if (!session) return;
    this.renderChrome({ index: session.index, total: session.total });
    this.setView(loadingBlock('地図を読み込んでいます'));

    let createQuizScreen: typeof import('./screens/quiz').createQuizScreen;
    try {
      ({ createQuizScreen } = await import('./screens/quiz'));
    } catch {
      this.setView(
        stateBlock('地図を読み込めませんでした', '通信状況を確認して、もう一度お試しください。'),
      );
      return;
    }
    // 読み込み中にホームへ戻っていたら何もしない
    if (this.session !== session) return;

    const screen = createQuizScreen(session, {
      onAnswered: () => {
        if (session.mode === 'complete_all') saveProgress(session.toProgress());
        this.renderChrome({ index: session.index, total: session.total });
      },
      onFinished: () => this.showSummary(),
      onQuit: () => undefined,
    });
    clear(this.view);
    append(this.view, screen.element);
    this.quiz = screen;
  }

  // -------------------------------------------------------------------------
  // セッション結果
  // -------------------------------------------------------------------------
  private showSummary(): void {
    const session = this.session;
    const data = this.data;
    if (!session || !data) return;
    this.renderChrome();

    const rate = session.achievementRate;
    const summary = el('div', { class: 'summary' });
    append(
      summary,
      el('h1', {}, session.mode === 'challenge10' ? '10問チャレンジ 終了' : '全地点制覇 終了'),
      el(
        'div',
        { class: 'summary__total' },
        el('span', { class: 'num' }, formatPoints(session.totalPoints)),
        el('span', { class: 'muted' }, `/ ${formatPoints(MAX_SCORE * session.total)} 点`),
      ),
      el(
        'p',
        { class: 'muted' },
        `達成率 ${(rate * 100).toFixed(1)}%` +
          (session.mode === 'complete_all'
            ? ` / 全${session.total}地点を踏破しました。`
            : ''),
      ),
    );

    const breakdown = el('div', { class: 'breakdown' });
    session.answered.forEach((answer, i) => {
      const point = session.pointAt(i);
      append(
        breakdown,
        el(
          'div',
          { class: 'breakdown__row' },
          el('span', { class: 'idx' }, String(i + 1)),
          el('span', {}, point ? (TYPE_LABELS[point.type] ?? point.type) : '—'),
          el('span', { class: 'dist' }, formatDistance(answer.distanceM)),
          el('span', { class: 'pts' }, formatPoints(answer.points)),
        ),
      );
    });
    append(summary, breakdown);

    const buttons = el('div', { class: 'row' });
    const again = el('button', { class: 'btn btn--primary', type: 'button' }, 'もう一度');
    again.addEventListener('click', () => this.startSession());
    const home = el('button', { class: 'btn btn--ghost', type: 'button' }, 'ホームへ');
    home.addEventListener('click', () => {
      this.session = null;
      this.showHome();
    });
    append(buttons, again, home);
    append(summary, buttons);

    this.setView(summary);
    if (session.mode === 'complete_all') clearProgress();
    void this.sendScore(session);
  }

  private async sendScore(session: QuizSession): Promise<void> {
    if (!remote.isConfigured() || !remote.currentPlayerId()) return;
    const ok = await remote.submitScore({
      mode: session.mode,
      view_mode: session.viewMode,
      points: session.totalPoints,
      point_count: session.total,
      dataset_version: session.data.dataset_version,
    });
    // 送信に失敗しても結果画面は消さない。知らせるだけ。
    toast(
      ok ? 'スコアを記録しました' : 'スコアを送信できませんでした（結果はこの画面に残ります）',
      ok ? 'info' : 'error',
    );
  }

  // -------------------------------------------------------------------------
  // リーダーボード
  // -------------------------------------------------------------------------
  private async showLeaderboard(
    mode: GameMode = 'challenge10',
    view: ViewMode = 'map2d',
  ): Promise<void> {
    this.renderChrome();
    const board = el('div', { class: 'board' });
    append(board, el('h1', {}, 'リーダーボード'));

    const tabs = el('div', { class: 'tabs', role: 'tablist' });
    for (const m of MODE_CHOICES) {
      for (const v of VIEW_CHOICES) {
        const isCurrent = m.value === mode && v.value === view;
        const tab = el(
          'button',
          { class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(isCurrent) },
          `${m.name} × ${v.name}`,
        );
        tab.addEventListener('click', () => void this.showLeaderboard(m.value, v.value));
        append(tabs, tab);
      }
    }
    append(board, tabs);

    const list = el('div', { class: 'panel' }, loadingBlock('順位を取得しています'));
    append(board, list);

    const back = el('button', { class: 'btn btn--ghost btn--block', type: 'button' }, 'ホームへ');
    back.addEventListener('click', () => this.showHome());
    append(board, back);
    this.setView(board);

    const rows = await remote.fetchRanking(mode, view);
    clear(list);
    if (rows === null) {
      append(
        list,
        stateBlock(
          '順位を取得できませんでした',
          'リーダーボードは記録の参考表示です。ゲーム本体は問題なく遊べます。',
        ),
      );
      return;
    }
    if (rows.length === 0) {
      append(list, stateBlock('まだ記録がありません', 'この組み合わせの最初の記録を作りましょう。'));
      return;
    }
    rows.forEach((row, i) => {
      const value =
        mode === 'complete_all'
          ? `${(row.achievement_rate * 100).toFixed(1)}%`
          : formatPoints(row.points);
      append(
        list,
        el(
          'div',
          { class: `rank${row.isMe ? ' rank--me' : ''}` },
          el('span', { class: 'rank__pos' }, String(i + 1)),
          el('span', { class: 'rank__name' }, row.nickname),
          el('span', { class: 'rank__score' }, value),
        ),
      );
    });
  }

  // -------------------------------------------------------------------------
  // ニックネーム
  // -------------------------------------------------------------------------
  private askNickname(): void {
    const dialog = el('dialog', { class: 'modal' }) as HTMLDialogElement;
    const input = el('input', {
      class: 'input',
      type: 'text',
      id: 'yg-nickname',
      maxlength: remote.NICKNAME_MAX,
      value: loadSettings().nickname ?? '',
      autocomplete: 'nickname',
    }) as HTMLInputElement;
    const error = el('p', { class: 'field__error', role: 'alert' });
    error.hidden = true;

    const cancel = el('button', { class: 'btn btn--ghost', type: 'button' }, 'あとで');
    const form = el(
      'form',
      { method: 'dialog', class: 'stack' },
      el('h2', {}, 'ニックネーム'),
      el(
        'p',
        { class: 'muted tiny' },
        'リーダーボードに表示される名前です。あとから変更できます。',
      ),
      el(
        'div',
        { class: 'field' },
        el(
          'label',
          { class: 'field__label', for: 'yg-nickname' },
          `${remote.NICKNAME_MAX}文字まで`,
        ),
        input,
        error,
      ),
      el(
        'div',
        { class: 'row' },
        el('button', { class: 'btn btn--primary', type: 'submit', value: 'ok' }, '保存'),
        cancel,
      ),
    );
    append(dialog, form);
    document.body.appendChild(dialog);
    dialog.showModal();
    input.focus();

    cancel.addEventListener('click', () => dialog.close());
    form.addEventListener('submit', (event) => {
      const message = remote.validateNickname(input.value);
      if (message) {
        event.preventDefault();
        error.textContent = message;
        error.hidden = false;
        input.focus();
        return;
      }
      void remote.saveNickname(input.value).then(() => this.renderChrome());
    });
    dialog.addEventListener('close', () => dialog.remove());
  }
}

export function mount(root: HTMLElement): Promise<void> {
  return new App(root).start();
}
