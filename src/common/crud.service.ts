import { NotFoundException } from '@nestjs/common';

export interface Identifiable {
  id: number;
}

export abstract class CrudService<
  Entity extends Identifiable,
  CreateDto,
  UpdateDto,
> {
  protected readonly items: Entity[] = [];
  private nextId = 1;

  findAll(): Entity[] {
    return this.items.map((item) => ({ ...item }));
  }

  findOne(id: number): Entity {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item)
      throw new NotFoundException(`${this.entityName} ${id} was not found`);
    return { ...item };
  }

  create(dto: CreateDto): Entity {
    const item = this.build(this.nextId++, dto);
    this.items.push(item);
    return { ...item };
  }

  update(id: number, dto: UpdateDto): Entity {
    const index = this.items.findIndex((item) => item.id === id);
    if (index === -1)
      throw new NotFoundException(`${this.entityName} ${id} was not found`);
    this.items[index] = { ...this.items[index], ...dto };
    return { ...this.items[index] };
  }

  remove(id: number): Entity {
    const index = this.items.findIndex((item) => item.id === id);
    if (index === -1)
      throw new NotFoundException(`${this.entityName} ${id} was not found`);
    const [removed] = this.items.splice(index, 1);
    return { ...removed };
  }

  protected abstract readonly entityName: string;
  protected abstract build(id: number, dto: CreateDto): Entity;
}
