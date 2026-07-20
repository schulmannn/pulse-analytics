import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MsRfmCustomers } from '@/api/queries';
import { downloadCsv, toCsv } from '@/lib/csv';
import {
  collectRfmSegmentRows,
  rfmCustomersCsvRows,
  rfmExportFilename,
} from './MsRfmCustomers';

type Row = MsRfmCustomers['rows'][number];

const row = (over: Partial<Row> = {}): Row => ({ ...baseRow(), ...over });
const baseRow = (): Row => ({
  agent_id: 'a1',
  name: 'ООО Ромашка',
  address: 'г. Москва, ул. Ленина, д. 1',
  city: 'Москва',
  orders: 3,
  sum: 4500,
  last_day: '2026-07-01',
  recency_days: 19,
  r: 3,
  f: 2,
  m: 2,
});

describe('rfmCustomersCsvRows', () => {
  it('проецирует строку сегмента в русские колонки в заданном порядке', () => {
    const lines = toCsv(rfmCustomersCsvRows([row()])).split('\r\n');
    expect(lines[0]).toBe('Покупатель,Адрес,Город,Заказов,Сумма ₽,Последний заказ,Дней с заказа,R,F,M');
    expect(lines[1]).toBe('ООО Ромашка,"г. Москва, ул. Ленина, д. 1",Москва,3,4500,2026-07-01,19,3,2,2');
  });

  it('эскейпит кавычки и разделители по RFC-4180 (канон lib/csv)', () => {
    const csv = toCsv(rfmCustomersCsvRows([row({ name: 'ИП "Иванов, И.И."', address: 'ул. Мира; д. 2', city: null })]));
    const cells = csv.split('\r\n')[1];
    expect(cells).toContain('"ИП ""Иванов, И.И."""');
    expect(cells).toContain('"ул. Мира; д. 2"');
  });

  it('null-поля словаря контрагентов — честные пустые ячейки', () => {
    const csv = toCsv(rfmCustomersCsvRows([row({ name: null, address: null, city: null, orders: 1, sum: 900 })]));
    expect(csv.split('\r\n')[1]).toBe(',,,1,900,2026-07-01,19,3,2,2');
  });
});

describe('rfmExportFilename', () => {
  it('rfm-<segment>-<YYYY-MM-DD>.csv по локальному дню скачивания', () => {
    expect(rfmExportFilename('at_risk', new Date(2026, 6, 20).getTime())).toBe('rfm-at_risk-2026-07-20.csv');
  });
});

describe('collectRfmSegmentRows', () => {
  it('копит страницы offset-циклом до total_customers', async () => {
    const pageRows = [row({ agent_id: 'a1' }), row({ agent_id: 'a2' }), row({ agent_id: 'a3' })];
    const fetchPage = vi.fn(async (offset: number) => ({
      rows: pageRows.slice(offset, offset + 2),
      total_customers: 3,
    }));
    const all = await collectRfmSegmentRows(fetchPage);
    expect(all.map((r) => r.agent_id)).toEqual(['a1', 'a2', 'a3']);
    expect(fetchPage).toHaveBeenNthCalledWith(1, 0);
    expect(fetchPage).toHaveBeenNthCalledWith(2, 2);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('пустая страница до total останавливает цикл (срез на сервере уменьшился)', async () => {
    const fetchPage = vi.fn(async (offset: number) =>
      offset === 0 ? { rows: [row()], total_customers: 10 } : { rows: [], total_customers: 10 },
    );
    const all = await collectRfmSegmentRows(fetchPage);
    expect(all).toHaveLength(1);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });
});

describe('скачивание через канон lib/csv', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('файл начинается с UTF-8 BOM и получает имя rfm-<segment>-<дата>.csv', async () => {
    const created: Blob[] = [];
    const link = { href: '', download: '', click: vi.fn(), remove: vi.fn() };
    vi.stubGlobal('document', { createElement: () => link, body: { appendChild: vi.fn() } });
    vi.stubGlobal('URL', {
      createObjectURL: (blob: Blob) => {
        created.push(blob);
        return 'blob:rfm';
      },
      revokeObjectURL: vi.fn(),
    });
    downloadCsv(rfmExportFilename('champions', new Date(2026, 6, 20).getTime()), rfmCustomersCsvRows([row()]));
    expect(link.download).toBe('rfm-champions-2026-07-20.csv');
    expect(link.click).toHaveBeenCalledTimes(1);
    // Blob.text() по спеке «UTF-8 decode» съедает ведущий BOM — проверяем сырые байты EF BB BF.
    const bytes = new Uint8Array(await created[0].arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    expect(await created[0].text()).toContain('Покупатель,Адрес,Город');
  });
});
