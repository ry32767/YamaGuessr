/**
 * テスト環境の最小の下支え。
 *
 * ブラウザ環境をまるごと持ち込むと重いので、実際に使っている localStorage だけを
 * メモリ実装で用意する（jsdom などの依存を足さないため）。
 */
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  const memoryStorage: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage });
}
