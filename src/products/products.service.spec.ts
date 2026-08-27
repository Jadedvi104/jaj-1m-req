import { NotFoundException } from '@nestjs/common';
import { ProductsService } from './products.service';

describe('ProductsService', () => {
  let service: ProductsService;
  beforeEach(() => {
    service = new ProductsService();
  });
  it('supports the full CRUD lifecycle', () => {
    const created = service.create({ name: 'Keyboard', price: 99 });
    expect(service.findAll()).toEqual([created]);
    const updated = service.update(created.id, { price: 89 });
    expect(updated).toEqual({ id: created.id, name: 'Keyboard', price: 89 });
    expect(service.remove(created.id)).toEqual(updated);
    expect(service.findAll()).toEqual([]);
  });
  it('throws for a missing product', () => {
    expect(() => service.update(999, { price: 10 })).toThrow(NotFoundException);
  });
});
