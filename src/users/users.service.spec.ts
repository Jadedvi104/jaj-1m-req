import { NotFoundException } from '@nestjs/common';
import { UsersService } from './users.service';

describe('UsersService', () => {
  let service: UsersService;
  beforeEach(() => {
    service = new UsersService();
  });
  it('supports the full CRUD lifecycle', () => {
    const created = service.create({ name: 'Ada', email: 'ada@example.com' });
    expect(service.findAll()).toEqual([created]);
    expect(service.findOne(created.id)).toEqual(created);
    const updated = service.update(created.id, { name: 'Ada Lovelace' });
    expect(updated).toEqual({ ...created, name: 'Ada Lovelace' });
    expect(service.remove(created.id)).toEqual(updated);
    expect(service.findAll()).toEqual([]);
  });
  it('throws for a missing user', () => {
    expect(() => service.findOne(999)).toThrow(NotFoundException);
  });
});
