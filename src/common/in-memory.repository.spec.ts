import { InMemoryUsersRepository } from '../users/in-memory-users.repository';
import { NotFoundException } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { InMemoryRepository } from './in-memory.repository';

describe('Shared CRUD storage contract', () => {
  let service: UsersService;
  beforeEach(() => {
    service = new UsersService(new InMemoryUsersRepository());
  });
  it('does not reuse deleted IDs', () => {
    const first = service.create({ name: 'A', email: 'a@example.com' });
    service.remove(first.id);
    expect(
      service.create({ name: 'B', email: 'b@example.com' }).id,
    ).toBeGreaterThan(first.id);
  });
  it('returns detached copies on create, list, read and update', () => {
    const created = service.create({ name: 'A', email: 'a@example.com' });
    created.name = 'modified';
    const list = service.findAll();
    list[0].name = 'modified';
    list.pop();
    service.findOne(created.id).name = 'modified';
    service.update(created.id, { email: 'new@example.com' }).name = 'modified';
    expect(service.findAll()).toEqual([
      { id: created.id, name: 'A', email: 'new@example.com' },
    ]);
  });
  it.each(['findOne', 'remove'] as const)(
    'rejects missing records for %s',
    (method) => {
      expect(() => service[method](999)).toThrow(NotFoundException);
    },
  );
  it('rejects missing updates', () => {
    expect(() => service.update(999, {})).toThrow(NotFoundException);
  });
  it('deletes only the requested record', () => {
    const first = service.create({ name: 'A', email: 'a@example.com' });
    const second = service.create({ name: 'B', email: 'b@example.com' });
    service.remove(first.id);
    expect(service.findAll()).toEqual([second]);
  });
  it('ignores inherited and prototype-control properties at the shared storage boundary', () => {
    class Repository extends InMemoryRepository<
      { id: number; name: string },
      { name: string },
      { name?: string }
    > {
      protected build(id: number, input: { name: string }) {
        return { id, name: input.name };
      }
    }
    const repository = new Repository();
    const record = repository.create({ name: 'original' });
    const inherited: { name?: string } = Object.create({
      name: 'inherited',
    }) as { name?: string };
    expect(repository.update(record.id, inherited)?.name).toBe('original');
    const poisoned = JSON.parse(
      '{"__proto__":{"admin":true},"constructor":"bad","prototype":"bad","name":"updated"}',
    ) as { name?: string };
    expect(repository.update(record.id, poisoned)).toEqual({
      id: record.id,
      name: 'updated',
    });
    expect(repository.findById(record.id)).not.toHaveProperty('admin');
  });
});
