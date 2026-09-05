export interface Identifiable {
  id: number;
}

/** Shared storage mechanics for flat records, without HTTP or domain policies. */
export abstract class InMemoryRepository<
  Entity extends Identifiable,
  CreateDto,
  UpdateDto extends Partial<Omit<Entity, 'id'>>,
> {
  private readonly records = new Map<number, Entity>();
  private nextId = 1;

  findAll(): Entity[] {
    return Array.from(this.records.values(), (record) => ({ ...record }));
  }

  findById(id: number): Entity | null {
    const record = this.records.get(id);
    return record ? { ...record } : null;
  }

  create(input: CreateDto): Entity {
    const record = this.build(this.nextId, input);
    this.records.set(this.nextId, { ...record });
    this.nextId++;
    return { ...record };
  }

  update(id: number, changes: UpdateDto): Entity | null {
    const record = this.records.get(id);
    if (!record) return null;
    const updated = { ...record };
    for (const key in changes) {
      const value = changes[key];
      if (value !== undefined) Object.assign(updated, { [key]: value });
    }
    updated.id = id;
    this.records.set(id, updated);
    return { ...updated };
  }

  remove(id: number): Entity | null {
    const record = this.findById(id);
    if (!record) return null;
    this.records.delete(id);
    return record;
  }

  protected abstract build(id: number, input: CreateDto): Entity;
}
