import { InMemoryProductsRepository } from './in-memory-products.repository';

describe('InMemoryProductsRepository', () => {
  let repository: InMemoryProductsRepository;
  const input = { name: 'Keyboard', price: 99, description: 'Original' };
  beforeEach(() => {
    repository = new InMemoryProductsRepository();
  });

  it('starts empty and reports missing records without HTTP exceptions', () => {
    expect(repository.findAll()).toEqual([]);
    expect(repository.findById(1)).toBeNull();
    expect(repository.update(1, {})).toBeNull();
    expect(repository.remove(1)).toBeNull();
  });

  it('preserves omitted fields and accepts falsy patch values', () => {
    const created = repository.create(input);
    const changes = { name: undefined, price: 0, description: '' };
    expect(repository.update(created.id, changes)).toEqual({
      ...created,
      ...changes,
      name: created.name,
    });
    expect(repository.update(created.id, {})).toEqual(
      repository.findById(created.id),
    );
  });

  it('selects allowed fields and protects generated IDs', () => {
    const extraInput = { ...input, id: 999, admin: true };
    const created = repository.create(extraInput);
    expect(created).toEqual({ ...input, id: 1 });
    const extraChanges = { name: 'Updated', id: 999, admin: true };
    expect(repository.update(1, extraChanges)).toEqual({
      ...input,
      id: 1,
      name: 'Updated',
    });
    expect(repository.findById(999)).toBeNull();
  });

  it('isolates input and output objects from stored records', () => {
    const source = { ...input };
    const created = repository.create(source);
    source.name = 'Changed input';
    created.name = 'Changed output';
    const [listed] = repository.findAll();
    if (!listed) throw new Error('Expected stored record');
    listed.name = 'Changed list';
    const read = repository.findById(1);
    if (!read) throw new Error('Expected stored record');
    read.name = 'Changed read';
    const updated = repository.update(1, {});
    if (!updated) throw new Error('Expected updated record');
    updated.name = 'Changed update';
    expect(repository.findById(1)).toEqual({ ...input, id: 1 });
  });

  it('deletes only the target and never reuses its ID', () => {
    const first = repository.create(input);
    const second = repository.create(input);
    expect(repository.remove(first.id)).toEqual(first);
    expect(repository.findAll()).toEqual([second]);
    expect(repository.create(input).id).toBeGreaterThan(second.id);
  });
});
