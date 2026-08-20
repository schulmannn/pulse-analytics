import type { SettingsIconName } from '@/components/settings/primitives';

export type SettingsSectionKey =
  | 'account'
  | 'appearance'
  | 'security'
  | 'billing'
  | 'team'
  | 'data'
  | 'channels';

export interface SettingsSection {
  key: SettingsSectionKey;
  label: string;
  icon: SettingsIconName;
  description: string;
}

export interface SettingsGroupDef {
  key: 'profile' | 'workspace' | 'connections';
  label: string;
  items: readonly SettingsSection[];
}

const ACCOUNT: SettingsSection = {
  key: 'account',
  label: 'Профиль',
  icon: 'user',
  description: 'Фото и основные данные, с которыми вы входите в Atlavue.',
};

const APPEARANCE: SettingsSection = {
  key: 'appearance',
  label: 'Оформление',
  icon: 'sun',
  description: 'Тема интерфейса на этом устройстве.',
};

const SECURITY: SettingsSection = {
  key: 'security',
  label: 'Безопасность',
  icon: 'lock',
  description: 'Пароль и управление аккаунтом.',
};

const BILLING: SettingsSection = {
  key: 'billing',
  label: 'Подписка',
  icon: 'card',
  description: 'Текущий тариф, возможности и лимиты.',
};

const TEAM: SettingsSection = {
  key: 'team',
  label: 'Команда',
  icon: 'users',
  description: 'Участники, роли и совместный доступ.',
};

const DATA: SettingsSection = {
  key: 'data',
  label: 'Данные',
  icon: 'database',
  description: 'Состояние сбора, экспорт и переносимость данных.',
};

const CHANNELS: SettingsSection = {
  key: 'channels',
  label: 'Каналы',
  icon: 'signal',
  description: 'Telegram-каналы, коллекторы и подключение Instagram.',
};

export const SETTINGS_GROUPS: readonly SettingsGroupDef[] = [
  {
    key: 'profile',
    label: 'Аккаунт',
    items: [ACCOUNT, APPEARANCE, SECURITY],
  },
  {
    key: 'workspace',
    label: 'Рабочее пространство',
    items: [BILLING, TEAM, DATA],
  },
  {
    key: 'connections',
    label: 'Подключения',
    items: [CHANNELS],
  },
];

/** Устаревшие deep-link ключи: «Instagram» слит в «Каналы» (2026-08), старые ссылки не 404-ятся. */
export const LEGACY_SECTION_ALIASES: Record<string, SettingsSectionKey> = {
  instagram: 'channels',
};

export const SETTINGS_SECTIONS: readonly SettingsSection[] = SETTINGS_GROUPS.flatMap(
  (group) => group.items,
);

export const isSettingsSection = (raw: string | null): raw is SettingsSectionKey =>
  SETTINGS_SECTIONS.some((section) => section.key === raw);
