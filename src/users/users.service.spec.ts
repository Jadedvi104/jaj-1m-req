import { UsersRepository } from './users.repository';
import { InMemoryUsersRepository } from './in-memory-users.repository';
import { NotFoundException } from '@nestjs/common';
import { UsersService } from './users.service';

describe('UsersService', () => {
  let service: UsersService;
  beforeEach(() => {
    service = new UsersService(new InMemoryUsersRepository());
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

describe('UsersService repository boundary', () => {
  let repository: jest.Mocked<UsersRepository>;
  let service: UsersService;
  const input = { name: 'Ada', email: 'ada@example.com' };
  const record = { id: 1, ...input };
  const changes = { name: 'Grace' };

  beforeEach(() => {
    repository = {
      findAll: jest.fn(),
      findById: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    };
    service = new UsersService(repository);
  });

  it('delegates each operation and preserves repository results', () => {
    repository.findAll.mockReturnValue([record]);
    repository.findById.mockReturnValue(record);
    repository.create.mockReturnValue(record);
    repository.update.mockReturnValue({ ...record, ...changes });
    repository.remove.mockReturnValue(record);
    expect(service.findAll()).toEqual([record]);
    expect(service.findOne(1)).toBe(record);
    expect(service.create(input)).toBe(record);
    expect(service.update(1, changes)).toEqual({ ...record, ...changes });
    expect(service.remove(1)).toBe(record);
    expect(repository.findById.mock.calls).toEqual([[1]]);
    expect(repository.create.mock.calls).toEqual([[input]]);
    expect(repository.update.mock.calls).toEqual([[1, changes]]);
    expect(repository.remove.mock.calls).toEqual([[1]]);
  });

  it('returns an empty collection', () => {
    repository.findAll.mockReturnValue([]);
    expect(service.findAll()).toEqual([]);
  });

  it.each(['findOne', 'update', 'remove'] as const)(
    'maps absent records to 404 for %s',
    (method) => {
      repository.findById.mockReturnValue(null);
      repository.update.mockReturnValue(null);
      repository.remove.mockReturnValue(null);
      expect(() => service[method](42, {})).toThrow(
        new NotFoundException('User 42 was not found'),
      );
    },
  );

  it.each(['findAll', 'findOne', 'create', 'update', 'remove'] as const)(
    'propagates storage errors for %s',
    (method) => {
      const failure = new Error('storage unavailable');
      const fail = () => {
        throw failure;
      };
      repository.findAll.mockImplementation(fail);
      repository.findById.mockImplementation(fail);
      repository.create.mockImplementation(fail);
      repository.update.mockImplementation(fail);
      repository.remove.mockImplementation(fail);
      const operations = {
        findAll: () => service.findAll(),
        findOne: () => service.findOne(1),
        create: () => service.create(input),
        update: () => service.update(1, changes),
        remove: () => service.remove(1),
      };
      expect(operations[method]).toThrow(failure);
    },
  );
});
