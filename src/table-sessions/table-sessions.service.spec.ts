import { BadRequestException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { TableSessionsService } from './table-sessions.service';

describe('TableSessionsService', () => {
  const dto = {
    branchId: 'branch',
    tablePublicId: 'table',
    rotatingCode: 'secret',
  };
  it('maps a verified session and parameterizes the presence code', async () => {
    const expires = new Date('2030-01-01');
    const query = jest.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{ id: 'session', expires_at: expires }],
    });
    const service = new TableSessionsService({
      query,
    } as unknown as DatabaseService);
    await expect(service.create(dto)).resolves.toEqual({
      sessionId: 'session',
      expiresAt: expires,
    });
    expect(query).toHaveBeenCalledWith(expect.any(String), [
      'branch',
      'table',
      'secret',
    ]);
  });
  it('rejects invalid, inactive or expired table credentials', async () => {
    const query = jest.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    await expect(
      new TableSessionsService({ query } as unknown as DatabaseService).create(
        dto,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
  it('propagates storage failure', async () => {
    const query = jest.fn().mockRejectedValue(new Error('offline'));
    await expect(
      new TableSessionsService({ query } as unknown as DatabaseService).create(
        dto,
      ),
    ).rejects.toThrow('offline');
  });
});
