/**
 * ログイン入力の検証とエラー文言（機能K）。
 *
 * ここで試すのは**通信しない純粋な関数だけ**。Supabaseへの実際の登録・ログインは
 * 鍵とネットワークが要るので、docs/spec.mdの「実地確認」として手で確かめる。
 */
import { describe, expect, it } from 'vitest';
import {
  NICKNAME_MAX,
  PASSWORD_MIN,
  describeAuthError,
  validateEmail,
  validateNickname,
  validatePassword,
} from './supabase';

describe('validateEmail', () => {
  it('通常のメールアドレスを受け入れる', () => {
    expect(validateEmail('yama@example.jp')).toBeNull();
    expect(validateEmail('a.b+tag@sub.example.co.jp')).toBeNull();
  });

  it('前後の空白は無視する（コピペ対策）', () => {
    expect(validateEmail('  yama@example.jp  ')).toBeNull();
  });

  it('空なら入力を促す', () => {
    expect(validateEmail('')).toBe('メールアドレスを入力してください');
    expect(validateEmail('   ')).toBe('メールアドレスを入力してください');
  });

  it('形式が違えば形式のエラーにする', () => {
    for (const bad of ['yama', 'yama@', '@example.jp', 'yama@example', 'ya ma@example.jp']) {
      expect(validateEmail(bad)).toBe('メールアドレスの形式が正しくありません');
    }
  });
});

describe('validatePassword', () => {
  it(`${PASSWORD_MIN}文字以上なら通す`, () => {
    expect(validatePassword('a'.repeat(PASSWORD_MIN))).toBeNull();
    expect(validatePassword('a'.repeat(PASSWORD_MIN + 20))).toBeNull();
  });

  it('空なら入力を促す', () => {
    expect(validatePassword('')).toBe('パスワードを入力してください');
  });

  it(`${PASSWORD_MIN}文字未満は文字数のエラーにする`, () => {
    expect(validatePassword('a'.repeat(PASSWORD_MIN - 1))).toBe(
      `パスワードは${PASSWORD_MIN}文字以上にしてください`,
    );
  });

  it('空白だけのパスワードは長さだけで判定する（意図的な空白を潰さない）', () => {
    expect(validatePassword(' '.repeat(PASSWORD_MIN))).toBeNull();
  });
});

describe('validateNickname', () => {
  it(`${NICKNAME_MAX}文字までなら通す`, () => {
    expect(validateNickname('やま')).toBeNull();
    expect(validateNickname('あ'.repeat(NICKNAME_MAX))).toBeNull();
  });

  it('空・空白だけなら入力を促す', () => {
    expect(validateNickname('')).toBe('ニックネームを入力してください');
    expect(validateNickname('   ')).toBe('ニックネームを入力してください');
  });

  it(`${NICKNAME_MAX}文字を超えたら弾く（DB側のCHECKと同じ上限）`, () => {
    expect(validateNickname('あ'.repeat(NICKNAME_MAX + 1))).toBe(
      `${NICKNAME_MAX}文字以内で入力してください`,
    );
  });
});

describe('describeAuthError', () => {
  it('よくあるSupabaseのエラーを日本語にする', () => {
    expect(describeAuthError('Invalid login credentials')).toBe(
      'メールアドレスかパスワードが違います',
    );
    expect(describeAuthError('User already registered')).toContain('登録済み');
    expect(describeAuthError('Email not confirmed')).toContain('確認メール');
    expect(describeAuthError('Signups not allowed for this instance')).toContain('新規登録が無効');
    expect(describeAuthError('email rate limit exceeded')).toContain('しばらく待って');
    expect(describeAuthError('Failed to fetch')).toContain('ネットワーク');
  });

  it('大文字小文字が違っても拾う', () => {
    expect(describeAuthError('INVALID LOGIN CREDENTIALS')).toBe(
      'メールアドレスかパスワードが違います',
    );
  });

  it('Supabaseが弾いたメールアドレスを案内に変える', () => {
    expect(describeAuthError('Email address "a@example.com" is invalid')).toContain(
      'このメールアドレスは使えません',
    );
  });

  it('パスワード長のサーバ側エラーも文字数の案内にそろえる', () => {
    expect(describeAuthError('Password should be at least 6 characters')).toBe(
      `パスワードは${PASSWORD_MIN}文字以上にしてください`,
    );
  });

  it('未知のエラーは原文を残す（原因を追えなくしない）', () => {
    const message = describeAuthError('Some brand new failure');
    expect(message).toContain('Some brand new failure');
    expect(message).toContain('ログインできませんでした');
  });
});
